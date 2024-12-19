import z from 'zod'
import type {JSONValue} from 'ai'

export const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() => z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.record(jsonValueSchema),
    z.array(jsonValueSchema)
]))

export type JSONSerializableObject = {[key: string]: JSONValue}
