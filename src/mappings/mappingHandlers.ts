import { SubstrateExtrinsic, SubstrateEvent, SubstrateBlock } from "@subql/types";
import { SpecVersion, Event, Extrinsic } from "../types";
import { AnyTuple, ArgsDef } from '@polkadot/types/types';
import { Block } from "../types/models/Block";
import { IEvent } from '@polkadot/types/types'
import { u32 } from '@polkadot/types'
import type { Vec } from '@polkadot/types'
import { Call } from "../types/models/Call";

export const getKVData = (data: AnyTuple, keys?: ArgsDef) => {
    if (!data) return [];


    if (!keys) {
        return data.map((item, index) => {
            return {
                key: '' + index,
                type: (data as any).typeDef?.[index]?.type?.toString(),
                value: item?.toString()
            }
        })
    }

    return Object.keys(keys).map((_key, index) => {
        return {
            key: _key,
            type: (data[index] as any).type,
            value: data[index]?.toString()
        }
    })
}

export const getBatchInterruptedIndex = (extrinsic: SubstrateExtrinsic): number => {
    const { events } = extrinsic

    const interruptedEvent = events.find((event) => {
        const _event = event?.event

        if (!_event) return false

        const { section, method } = _event

        return section === 'utility' && method === 'BatchInterrupted'
    })

    if (interruptedEvent) {
        const { data } = (interruptedEvent.event as unknown) as IEvent<[u32]>

        return Number(data[0].toString())
    }

    return -1
}

async function traverExtrinsic(extrinsic: Extrinsic, raw: SubstrateExtrinsic): Promise<Call[]> {
    const list = []
    const batchInterruptedIndex = getBatchInterruptedIndex(raw)

    const inner = async (
        data: any,
        parentCallId: string,
        idx: number,
        isRoot: boolean,
        depth: number
    ) => {
        const id = isRoot ? parentCallId : `${parentCallId}-${idx}`
        const method = data.method
        const section = data.section
        const args = data.args

        const call = new Call(id)

        call.method = method
        call.section = section
        call.args = getKVData(data.args, data.argsDef)
        call.signer = raw.extrinsic.signer.toString();
        call.isSuccess = depth === 0 ? extrinsic.success : batchInterruptedIndex > idx;
        call.timestamp = extrinsic.timestamp

        if (!isRoot) {
            call.parentCallId = isRoot ? '' : parentCallId

            call.extrinsicId = parentCallId.split('-')[0]
        } else {
            call.extrinsicId = parentCallId
        }

        list.push(call)

        if (depth < 1 && section === 'utility' && (method === 'batch' || method === 'batchAll')) {
            const temp = args[0];

            await Promise.all(temp.map((item, idx) => inner(item, id, idx, false, depth + 1)))
        }
    }

    await inner(raw.extrinsic.method, extrinsic.id, 0, true, 0)

    return list
}

export async function createCalls(extrinsic: Extrinsic, raw: SubstrateExtrinsic) {

    const calls = await traverExtrinsic(extrinsic, raw)

    await Promise.all(calls.map(async (item) => item.save()));
}

export async function ensureCallExist(id) {
    let data = await Call.get(id)

    if (!data) {
        data = new Call(id)

        await data.save()
    }

    return data
}


export async function handleBlock(block: SubstrateBlock): Promise<void> {
    const specVersion = await SpecVersion.get(block.specVersion.toString());
    if (specVersion === undefined) {
        const newSpecVersion = new SpecVersion(block.specVersion.toString());
        newSpecVersion.blockHeight = block.block.header.number.toBigInt();
        await newSpecVersion.save();
    }

    const blockData = await Block.get(block.block.header.number.toString());
    if (blockData === undefined) {
        const newBlock = new Block(block.block.hash.toString());
        newBlock.height = block.block.header.number.toBigInt();
        newBlock.timestamp = block.timestamp;
        await newBlock.save();
    }
}

export async function handleEvent(event: SubstrateEvent): Promise<void> {
    const thisEvent = await Event.get(`${event.block.block.header.number}-${event.idx.toString()}`);
    await handleBlock(event.block);
    if (thisEvent === undefined) {
        const newEvent = new Event(`${event.block.block.header.number}-${event.idx.toString()}`);
        newEvent.blockId = event.block.block.hash.toString()
        newEvent.module = event.event.section;
        newEvent.event = event.event.method;
        newEvent.data = getKVData(event.event.data);
        await newEvent.save();
    }
}

export async function handleCall(extrinsic: SubstrateExtrinsic): Promise<void> {
    const thisExtrinsic = await Extrinsic.get(extrinsic.extrinsic.hash.toString());
    await handleBlock(extrinsic.block);
    if (thisExtrinsic === undefined) {
        const newExtrinsic = new Extrinsic(extrinsic.extrinsic.hash.toString());
        newExtrinsic.module = extrinsic.extrinsic.method.section;
        newExtrinsic.call = extrinsic.extrinsic.method.method;
        newExtrinsic.blockId = extrinsic.block.block.hash.toString();
        newExtrinsic.success = extrinsic.success;
        newExtrinsic.isSigned = extrinsic.extrinsic.isSigned;
        await newExtrinsic.save();

        await ensureCallExist(newExtrinsic.id);
        await createCalls(newExtrinsic, extrinsic)
    }
}


