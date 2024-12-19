import z from 'zod'
import type {JSONValue} from 'ai'

/**
 * Deep-copy an object using JSON.parse and JSON.stringify. This will not work for complex objects, and may be slow
 * as your object size increases
 * @param object
 */
export function deepCopy<T>(object: any): T{
    return JSON.parse(JSON.stringify(object))
}


export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() => z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.record(jsonValueSchema),
    z.array(jsonValueSchema)
]))
export type JSONSerializableObject = { [key: string]: JSONValue }