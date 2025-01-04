import z from 'zod'
import {
    type CoreTool,
    type JSONValue,
    type TextStreamPart
} from 'ai'

/**
 * Deep-copy an object using JSON.parse and JSON.stringify. This will not work for complex objects, and may be slow
 * as your object size increases
 * @param object
 */
export function deepCopy<T>(object: any): T {
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

export type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>

export function createAsyncIterableStream<T>(
    source: ReadableStream<T>
): AsyncIterableStream<T> {

    const stream: ReadableStream<T> = source.pipeThrough(new TransformStream<T, T>());

    // @ts-expect-error AI SDK implementation works fine
    (stream as AsyncIterableStream<T>)[Symbol.asyncIterator] = () => {
        const reader = stream.getReader();
        return {
            async next(): Promise<IteratorResult<T>> {
                const {done, value} = await reader.read();
                return done ? {done: true, value: undefined} : {done: false, value};
            },
        };
    };

    return stream as AsyncIterableStream<T>;
}


/**
 * Creates a stitchable stream that can pipe one stream at a time.
 *
 * @template T - The type of values emitted by the streams.
 * @returns {Object} An object containing the stitchable stream and control methods.
 */
export function createStitchableStream<T>(): {
    stream: ReadableStream<T>;
    addStream: (innerStream: ReadableStream<T>) => void;
    enqueue: (c: T) => void
    close: () => void;
} {
    let innerStreamReaders: ReadableStreamDefaultReader<T>[] = [];
    let controller: ReadableStreamDefaultController<T> | null = null;
    let isClosed = false;
    let waitForNewStream = createResolvablePromise<void>();

    const processPull = async () => {
        // Case 1: Outer stream is closed and no more inner streams
        if (isClosed && innerStreamReaders.length === 0) {
            controller?.close();
            return;
        }

        // Case 2: No inner streams available, but outer stream is open
        // wait for a new inner stream to be added or the outer stream to close
        if (innerStreamReaders.length === 0) {
            waitForNewStream = createResolvablePromise<void>();
            await waitForNewStream.promise;
            return processPull();
        }

        try {
            const {value, done} = await innerStreamReaders[0].read();

            if (done) {
                // Case 3: Current inner stream is done
                innerStreamReaders.shift(); // Remove the finished stream

                // Continue pulling from the next stream if available
                if (innerStreamReaders.length > 0) {
                    await processPull();
                }
                else if (isClosed) {
                    controller?.close();
                }
            }
            else {
                // Case 4: Current inner stream returns an item
                controller?.enqueue(value);
            }
        }
        catch (error) {
            // Case 5: Current inner stream throws an error
            controller?.error(error);
            innerStreamReaders.shift(); // Remove the errored stream

            if (isClosed && innerStreamReaders.length === 0) {
                controller?.close();
            }
        }
    };


    const stream = new ReadableStream<T>({
        start(controllerParam) {
            controller = controllerParam;
        },
        pull: processPull,
        async cancel() {
            for (const reader of innerStreamReaders) {
                await reader.cancel();
            }
            innerStreamReaders = [];
            isClosed = true;
        },
    })
    return {
        stream: stream,
        enqueue: (c: T) => controller?.enqueue(c),
        addStream: (innerStream: ReadableStream<T>) => {
            if (isClosed) {
                throw new Error('Cannot add inner stream: outer stream is closed');
            }

            innerStreamReaders.push(innerStream.getReader());
            waitForNewStream.resolve();
        },
        close: () => {
            isClosed = true;
            waitForNewStream.resolve();

            if (innerStreamReaders.length === 0) {
                controller?.close();
            }
        },
    };
}

/**
 * Creates a Promise with externally accessible resolve and reject functions.
 *
 * @template T - The type of the value that the Promise will resolve to.
 * @returns An object containing:
 *   - promise: A Promise that can be resolved or rejected externally.
 *   - resolve: A function to resolve the Promise with a value of type T.
 *   - reject: A function to reject the Promise with an error.
 */
export function createResolvablePromise<T = any>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve: (value: T) => void;
    let reject: (error: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve: resolve!,
        reject: reject!,
    };
}

/**
 * Types copied/pasted from AI SDK so that I can add the 'handover' property
 */
export type EnrichedStreamPart<
    TOOLS extends Record<string, CoreTool>,
    PARTIAL_OUTPUT,
> = {
    part: TextStreamPart<TOOLS>;
    partialOutput: PARTIAL_OUTPUT | undefined;
};

type TextStreamPartWithoutToolResult<TOOLS extends Record<string, CoreTool>> = Exclude<TextStreamPart<TOOLS>, {
    type: 'tool-result'
}>
type TextStreamPartToolResult<TOOLS extends Record<string, CoreTool>> = Extract<TextStreamPart<TOOLS>, {
    type: 'tool-result'
}>
type NewToolResultPart<TOOLS extends Record<string, CoreTool>> = TextStreamPartToolResult<TOOLS> &
    { handedOverTo?: { name: string, id: string } };


export type ExtendedTextStreamPart<TOOLS extends Record<string, CoreTool>> = (TextStreamPartWithoutToolResult<TOOLS> |
    NewToolResultPart<TOOLS>) & {
    agent: { id: string, name: string }
}

export type ExtendedEnrichedStreamPart<
    TOOLS extends Record<string, CoreTool>,
    PARTIAL_OUTPUT,
> = {
    part: ExtendedTextStreamPart<TOOLS>;
    partialOutput: PARTIAL_OUTPUT | undefined;
};