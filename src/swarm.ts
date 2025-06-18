import { openai } from "@ai-sdk/openai";
import type {
  CoreAssistantMessage,
  CoreMessage,
  CoreSystemMessage,
  CoreTool,
  CoreToolMessage,
  CoreUserMessage,
  FinishReason,
  GenerateTextResult,
  LanguageModel,
  StepResult,
  StreamTextResult,
  TextStreamPart,
  ToolExecutionOptions,
  UserContent,
} from "ai";
import { generateText, streamText, tool } from "ai";
import z from "zod";
import { Agent, type AgentHandoverTool, type AgentTool } from "./agent";
import {
  createAsyncIterableStream,
  createResolvablePromise,
  createStitchableStream,
  type EnrichedStreamPart,
  type ExtendedEnrichedStreamPart,
  type ExtendedTextStreamPart,
  type JSONSerializableObject,
} from "./utils";

const SWARM_CONTEXT_PROPERTY_NAME = "swarmContext";

export type SwarmMessage =
  | (CoreAssistantMessage & { sender?: string })
  | CoreUserMessage
  | CoreToolMessage
  | CoreSystemMessage;

export type SwarmOptions<
  SWARM_CONTEXT extends object = JSONSerializableObject
> = {
  defaultModel?: LanguageModel;
  queen: Agent<SWARM_CONTEXT>;
  initialContext: SWARM_CONTEXT;
  messages?: Array<SwarmMessage>;
  name?: string;
  maxTurns?: number;
  returnToQueen?: boolean; // should control of the swarm be returned to the queen post-completion?
};

/**
 * Invoke the swarm to handle a user message
 */
export type BaseSwarmInvocationOptions<
  SWARM_CONTEXT extends object = JSONSerializableObject
> = {
  contextUpdate?: Partial<SWARM_CONTEXT>;
  setAgent?: Agent<SWARM_CONTEXT>;
  maxTurns?: number;
  returnToQueen?: boolean; // should control of the swarm be returned to the queen post-completion?
  onStepFinish?: (
    event: StepResult<any>,
    context: SWARM_CONTEXT
  ) => Promise<void> | void;
};

type SwarmInvocationWithContent = {
  content: UserContent;
  messages?: undefined;
};

type SwarmInvocationWithMessages = {
  content?: undefined;
  messages: Array<SwarmMessage>;
};

export type SwarmInvocationOptions<SWARM_CONTEXT extends object> =
  BaseSwarmInvocationOptions<SWARM_CONTEXT> &
    (SwarmInvocationWithContent | SwarmInvocationWithMessages);

export type SwarmStreamingOptions = {
  experimental_toolCallStreaming?: boolean;
};

export type SwarmToDataStreamOptions = {
  data?: any;
  getErrorMessage?: (error: unknown) => string;
  sendUsage?: boolean;
  sendReasoning?: boolean;
  sendSources?: boolean;
  experimental_sendFinish?: boolean;
  experimental_sendStart?: boolean;
};

/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm<SWARM_CONTEXT extends object = any> {
  readonly defaultModel: LanguageModel;
  readonly name?: string;
  public readonly queen: Agent<SWARM_CONTEXT>;
  protected context: SWARM_CONTEXT;
  protected messages: Array<SwarmMessage>;
  protected readonly maxTurns: number;
  protected readonly returnToQueen: boolean;

  constructor(options: SwarmOptions<SWARM_CONTEXT>) {
    this.context = options.initialContext;
    this.defaultModel = options.defaultModel || openai("gpt-4o-mini");
    this.queen = options.queen;
    this._activeAgent = options.queen;
    this.messages = options.messages || [];
    this.name = options.name;
    this.maxTurns = options.maxTurns || 100;
    this.returnToQueen = !!options.returnToQueen;
  }

  protected _activeAgent: Agent<SWARM_CONTEXT>;

  public get activeAgent() {
    return this._activeAgent as Readonly<Agent<SWARM_CONTEXT>>;
  }

  /**
   * Use the swarm to generate text / tool calls
   */
  public async generateText(options: SwarmInvocationOptions<SWARM_CONTEXT>) {
    // handle any swarm updates & overrides based on the user input - active agent, messages, etc
    this.handleUpdatesAndOverrides(options);

    const initialMessages: Array<CoreMessage> = options.messages
      ? this.messages
      : [...this.messages, { role: "user", content: options.content }];

    // Can generate prompt instead too
    let lastResult: GenerateTextResult<any, any>;
    const responseMessages: Array<SwarmMessage> = [];
    const processedHandoverCallIds = new Set<string>(); // Track processed handover calls

    const maxTotalSteps = options.maxTurns ?? this.maxTurns;
    do {
      const initialAgent = this._activeAgent;

      // Run the LLM generation.
      lastResult = await generateText({
        model: this._activeAgent.config.model || this.defaultModel,
        system: this._activeAgent.getInstructions(this.context),
        tools: this.wrapTools(this._activeAgent.tools), // Wrap tools to hide the swarmContext from the LLM; it
        // will be passed once the LLM invokes the tools
        maxSteps: this._activeAgent.config.maxTurns ?? maxTotalSteps,
        // @ts-expect-error
        toolChoice: this._activeAgent.config.toolChoice,
        onStepFinish: options.onStepFinish
          ? (stepResult) => options.onStepFinish!(stepResult, this.context)
          : undefined,
        messages: [...initialMessages, ...responseMessages],
      });

      // On completion, add messages with name of current assistant
      responseMessages.push(
        ...lastResult.response.messages.map((message) => ({
          ...message,
          sender: this._activeAgent.name,
        }))
      );

      // Find unhandled tool calls by looking for a call with an ID that is not included in the tool call results
      const { toolCalls, toolResults } = lastResult;
      const toolResultIds = toolResults.map((result) => result.toolCallId);
      const unhandledToolCalls = toolCalls.filter(
        (toolCall) =>
          !toolResultIds.includes(toolCall.toolCallId) &&
          !processedHandoverCallIds.has(toolCall.toolCallId)
      );

      // Find handover calls - a tool call _without_ a result and whose "unwrapped" form that the agent has
      //  indicates "type": "handover"
      const handoverCalls = unhandledToolCalls.filter(
        (toolCall) =>
          this._activeAgent.tools?.[toolCall.toolName].type === "handover"
      );

      // if the current agent generates text, we are done -- it's presenting an answer, so break
      if (
        ["stop", "length", "content-filter", "error"].includes(
          lastResult.finishReason
        )
      ) {
        // we're done, the model generated text
        break;
      }

      // If there are no unhandled tool calls and no handovers, we're done
      if (unhandledToolCalls.length === 0 && handoverCalls.length === 0) {
        break;
      }

      // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
      //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps

      // Process handover calls; although we only look at the first one if the agent
      if (handoverCalls.length > 0) {
        // Get the _originally_ defined handover tool from the agent's tool list; i.e. the unwrapped tool
        const handoverTool = this._activeAgent.tools?.[
          handoverCalls[0].toolName
        ]! as AgentHandoverTool<SWARM_CONTEXT, any>;

        // Execute the handover tool with the arguments generated by the LLM, _and_ the current context
        const result = await handoverTool.execute(
          {
            ...handoverCalls[0].args,
            ...this.context,
          },
          {}
        );

        // Based on the results of executing the user-supplied handover tool with the LLM-generated args and
        // context, update the active agent and update the context IFF a context update was specified
        this._activeAgent = result.agent;
        if (result.context)
          this.context = {
            ...this.context,
            ...result.context,
          };

        // Mark this handover call as processed
        processedHandoverCallIds.add(handoverCalls[0].toolCallId);

        // Add a tool result message for the handover to maintain conversation history
        const handoverResult = `Handing over to agent ${this._activeAgent.name}`;

        // Create a proper tool message for the handover
        const toolMessage: CoreToolMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: handoverCalls[0].toolCallId,
              toolName: handoverCalls[0].toolName,
              result: handoverResult,
            },
          ],
        };
        responseMessages.push(toolMessage);

        // locate the assistant message for the tool call (now it's at -2 since we added the tool message)
        const assistantMessage = responseMessages.at(
          -2
        ) as CoreAssistantMessage;

        // clean out unused tool calls
        if (typeof assistantMessage.content !== "string") {
          const unusedToolCallIds = handoverCalls
            .filter((call, index) => index > 0)
            .map((call) => call.toolCallId);

          assistantMessage.content = assistantMessage.content.filter((part) => {
            return part.type === "tool-call"
              ? !unusedToolCallIds.includes(part.toolCallId)
              : true;
          });
        }
      }

      // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
      //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps
      const assistantMessages = lastResult.response.messages.filter(
        (message) => message.role === "assistant"
      );
      if (
        initialAgent.config.maxTurns &&
        initialAgent.config.maxTurns === assistantMessages.length &&
        responseMessages.filter((message) => message.role === "assistant")
          .length < maxTotalSteps
      ) {
        // if this one agent reached their max calls, break
        break;
      }
    } while (
      responseMessages.filter((message) => message.role === "assistant")
        .length < maxTotalSteps
    );

    // update the stored state, then return a readonly version
    const lastRequest = lastResult?.request ?? {};
    const lastResponse = lastResult?.response ?? {
      id: "",
      timestamp: new Date(),
      modelId: this.defaultModel.modelId,
      messages: responseMessages,
    };

    // add the new user message if it was passed in
    if (options.content) {
      this.messages.push({ role: "user", content: options.content });
    }

    // add response messages to the conversation history
    this.messages.push(...responseMessages);

    if (options.returnToQueen ?? this.returnToQueen) {
      this._activeAgent = this.queen;
    }

    // Finally, return a readonly copy of the result.
    return {
      ...lastResult,
      activeAgent: this._activeAgent as Readonly<Agent<SWARM_CONTEXT>>,
      context: this.context as Readonly<SWARM_CONTEXT>,
      messages: this.messages as Readonly<Array<SwarmMessage>>,
      request: lastRequest,
      response: {
        ...lastResponse,
        messages: this.messages as Readonly<Array<SwarmMessage>>,
      },
    };
  }

  public streamText(
    options: SwarmInvocationOptions<SWARM_CONTEXT> & SwarmStreamingOptions
  ): {
    finishReason: Promise<FinishReason>;
    activeAgent: Promise<Readonly<Agent<SWARM_CONTEXT>>>;
    text: Promise<string>;
    messages: Promise<Array<SwarmMessage>>;
    context: Promise<SWARM_CONTEXT>;
    textStream: AsyncIterable<string>;
    fullStream: AsyncIterable<ExtendedTextStreamPart<any>>;
    toDataStream: (options?: SwarmToDataStreamOptions) => ReadableStream;
    toDataStreamResponse: (options?: SwarmToDataStreamOptions) => Response;
  } {
    // swarm updates and overrides
    this.handleUpdatesAndOverrides(options);
    const initialMessages: Array<CoreMessage> = options.messages
      ? this.messages
      : [...this.messages, { role: "user", content: options.content }];

    // Create promises that will be returned immediately and then resolved as soon as everything is available
    const finishReasonPromise = createResolvablePromise<FinishReason>();
    const activeAgentPromise =
      createResolvablePromise<Readonly<Agent<SWARM_CONTEXT>>>();
    const textPromise = createResolvablePromise<string>();
    const allResponseMessagesPromise =
      createResolvablePromise<Array<SwarmMessage>>();
    const contextPromise = createResolvablePromise<SWARM_CONTEXT>();

    // Set up a stream that can have other streams stitched into it
    let stitchableStream = createStitchableStream<
      ExtendedTextStreamPart<any> | TextStreamPart<any>
    >();
    let stream = stitchableStream.stream;
    let addStream = stitchableStream.addStream;
    let closeStream = stitchableStream.close;
    let enqueue = stitchableStream.enqueue;

    // Function to split the stream
    function teeStream() {
      const [stream1, stream2] = stream.tee();
      stream = stream2;
      return stream1;
    }

    // Create a copy of the stream that's ONLY text, no tool calls. each streamed thing is just text.
    const textStream = createAsyncIterableStream(
      teeStream().pipeThrough(
        new TransformStream<EnrichedStreamPart<any, any>["part"]>({
          transform: (streamPart, controller) => {
            if (streamPart?.type === "text-delta") {
              controller.enqueue(streamPart.textDelta);
            } else if (streamPart?.type === "error") {
              controller.error(streamPart.error);
            }
          },
        })
      )
    );

    // Create a copy of the stream that's everything generated by the stream; also adds the agent info
    // so client code can tell which agent is streaming.
    const fullStream = createAsyncIterableStream(
      teeStream().pipeThrough(
        new TransformStream<
          | ExtendedEnrichedStreamPart<any, any>["part"]
          | EnrichedStreamPart<any, any>["part"],
          ExtendedTextStreamPart<any>
        >({
          transform: (streamPart, controller) => {
            if ("agent" in streamPart) controller.enqueue(streamPart);
            else
              controller.enqueue({
                ...streamPart,
                agent: {
                  id: this._activeAgent.uuid,
                  name: this._activeAgent.name,
                },
              });
          },
        })
      )
    );

    // Inline an async function so we can handle generation and streaming in the background but return immediately
    (async () => {
      try {
        let lastResult: StreamTextResult<any, any>;
        const responseMessages: Array<SwarmMessage> = [];
        const processedHandoverCallIds = new Set<string>(); // Track processed handover calls
        const maxTotalSteps = options.maxTurns ?? this.maxTurns;
        let finalText = "";

        do {
          const initialAgent = this._activeAgent;
          // Run generation
          lastResult = streamText({
            model: this._activeAgent.config.model || this.defaultModel,
            system: this._activeAgent.getInstructions(this.context),
            tools: this.wrapTools(this._activeAgent.tools),
            maxSteps: this._activeAgent.config.maxTurns ?? maxTotalSteps,
            // @ts-expect-error
            toolChoice: this._activeAgent.config.toolChoice,
            onStepFinish: options.onStepFinish
              ? (stepResult) => options.onStepFinish!(stepResult, this.context)
              : undefined,
            messages: [...initialMessages, ...responseMessages],
            experimental_toolCallStreaming: !(
              options.experimental_toolCallStreaming === false
            ),
          });

          // It returns instantly, so add the stream, then await the response to be generated
          addStream(lastResult.fullStream);

          // add messages once finished
          const [response, finishReason, toolResults, toolCalls, text] =
            await Promise.all([
              lastResult.response,
              lastResult.finishReason,
              lastResult.toolResults,
              lastResult.toolCalls,
              lastResult.text,
            ]);

          finalText += text;

          responseMessages.push(
            ...response.messages.map((message: CoreMessage) => ({
              ...message,
              sender: this._activeAgent.name,
            }))
          );

          // find unhandled calls by looking for a call with an ID that is not included int he tool call result
          const toolResultIds = toolResults.map(
            (result: any) => result.toolCallId
          );
          const unhandledToolCalls = toolCalls.filter(
            (toolCall: any) =>
              !toolResultIds.includes(toolCall.toolCallId) &&
              !processedHandoverCallIds.has(toolCall.toolCallId)
          );

          // Find handover calls - a tool call _without_ a result and whose "unwrapped" form that the agent has
          //  indicates "type": "handover"
          const handoverCalls = unhandledToolCalls.filter(
            (toolCall: any) =>
              this._activeAgent.tools?.[toolCall.toolName].type === "handover"
          );

          // If the current agent generates text, we are done -- it's presenting an answer, so break
          if (
            ["stop", "length", "content-filter", "error"].includes(finishReason)
          ) {
            break;
          }

          // If there are no unhandled tool calls and no handovers, we're done
          if (unhandledToolCalls.length === 0 && handoverCalls.length === 0) {
            break;
          }

          // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
          //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps

          // Process handover calls; although we only look at the first one if the agent
          let handoverToolResult:
            | Extract<ExtendedTextStreamPart<any>, { type: "tool-result" }>
            | undefined = undefined;
          if (handoverCalls.length > 0) {
            // Get the _originally_ defined handover tool from the agent's tool list; i.e. the unwrapped tool
            const handoverTool = this._activeAgent.tools?.[
              handoverCalls[0].toolName
            ]! as AgentHandoverTool<SWARM_CONTEXT, any>;

            // save the previous agent's information for the stream delta
            const previousAgent = {
              name: this._activeAgent.name,
              id: this._activeAgent.uuid,
            };
            // Execute the handover tool with the arguments generated by the LLM, _and_ the current context
            const result = await handoverTool.execute(
              {
                ...handoverCalls[0].args,
                ...this.context,
              },
              {}
            );

            // Based on the results of executing the user-supplied handover tool with the LLM-generated args and
            // context, update the active agent and update the context IFF a context update was specified
            this._activeAgent = result.agent;
            if (result.context)
              this.context = {
                ...this.context,
                ...result.context,
              };

            // Mark this handover call as processed
            processedHandoverCallIds.add(handoverCalls[0].toolCallId);

            // Generate an "artificial" handover tool result to add to the history
            handoverToolResult = {
              type: "tool-result",
              toolCallId: handoverCalls[0].toolCallId,
              toolName: handoverCalls[0].toolName,
              result: `Handing over to agent ${this._activeAgent.name}`,
              handedOverTo: {
                id: this._activeAgent.uuid,
                name: this._activeAgent.name,
              },
              args: handoverCalls[0].args,
              agent: previousAgent,
            } satisfies ExtendedTextStreamPart<any>;
            // push the tool result into the stream
            enqueue(handoverToolResult);
          }

          // locate the assistant message for the tool call, and the tool-role tool response message
          const toolMessage =
            responseMessages.at(-1)?.role === "tool"
              ? (responseMessages.at(-1) as CoreToolMessage)
              : undefined;
          const assistantMessage = responseMessages.at(
            toolMessage === undefined ? -1 : -2
          ) as CoreAssistantMessage;

          // if we created a handover tool result for a handover -- i.e. if there was a handover
          if (handoverToolResult) {
            // If there is NO tool result message (because there was no executor) then we add a tool-result
            // message that contains the handover tool result
            if (toolMessage == null) {
              responseMessages.push({
                role: "tool",
                content: [handoverToolResult],
              });
            }
            // If there IS a tool result message (e.g. if there was a call and THEN a handover, add the
            // handover
            //  result to the existing message.
            else {
              toolMessage.content.push(handoverToolResult);
            }
          }

          // clean out unused tool calls
          if (typeof assistantMessage.content !== "string") {
            const unusedToolCallIds = handoverCalls
              .filter((call: any, index: number) => index > 0)
              .map((call: any) => call.toolCallId);

            assistantMessage.content = assistantMessage.content.filter(
              (part) => {
                return part.type === "tool-call"
                  ? !unusedToolCallIds.includes(part.toolCallId)
                  : true;
              }
            );
          }

          // So, if we haven't generated text or errored and we're here, that merans that execution either stopped
          //  Because of an agent transfer, which we already handled, OR because the agent ran out of max steps
          const assistantMessages = response.messages.filter(
            (message: CoreMessage) => message.role === "assistant"
          );
          if (
            initialAgent.config.maxTurns &&
            initialAgent.config.maxTurns === assistantMessages.length &&
            responseMessages.filter((message) => message.role === "assistant")
              .length < maxTotalSteps
          ) {
            // if this one agent reached their max calls, break
            break;
          }
        } while (
          responseMessages.filter((message) => message.role === "assistant")
            .length < maxTotalSteps
        );

        // Update state
        this.messages = [...this.messages, ...responseMessages];
        if (options.content) {
          this.messages.push({ role: "user", content: options.content });
        }
        if (options.returnToQueen ?? this.returnToQueen) {
          this._activeAgent = this.queen;
        }

        // Close the stream after all processing is done
        closeStream();

        // Resolve all promises
        finishReasonPromise.resolve(await lastResult.finishReason);
        activeAgentPromise.resolve(this._activeAgent);
        textPromise.resolve(finalText);
        allResponseMessagesPromise.resolve(this.messages);
        contextPromise.resolve(this.context);
      } catch (error) {
        // Handle errors by adding them to the stream and closing
        enqueue({
          type: "error",
          error,
          agent: {
            id: this._activeAgent.uuid,
            name: this._activeAgent.name,
          },
        } as ExtendedTextStreamPart<any>);
        closeStream();

        // Reject promises
        finishReasonPromise.reject(error);
        activeAgentPromise.reject(error);
        textPromise.reject(error);
        allResponseMessagesPromise.reject(error);
        contextPromise.reject(error);
      }
    })();

    const toDataStream = (options?: SwarmToDataStreamOptions) => {
      // Create a ReadableStream that transforms our fullStream format to AI SDK data stream format
      const dataStream = new ReadableStream({
        async start(controller) {
          try {
            // Send start event if not disabled
            if (options?.experimental_sendStart !== false) {
              const startEvent = `2:{}\n`;
              controller.enqueue(new TextEncoder().encode(startEvent));
            }

            for await (const chunk of fullStream) {
              let dataStreamChunk: string | null = null;
              // Type assertion needed because ExtendedTextStreamPart doesn't include all
              // TextStreamPart types from AI SDK (reasoning, source, file, etc.)
              // This is safe because we handle all cases in the switch statement
              const chunkAny = chunk as any;

              switch (chunkAny.type) {
                case "text-delta":
                  // Text delta: type 0
                  dataStreamChunk = `0:"${chunkAny.textDelta
                    .replace(/\\/g, "\\\\")
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, "\\n")
                    .replace(/\r/g, "\\r")
                    .replace(/\t/g, "\\t")}"\n`;
                  break;

                case "reasoning":
                  // Reasoning: only send if enabled
                  if (options?.sendReasoning) {
                    dataStreamChunk = `reasoning:${chunkAny.textDelta}\n`;
                  }
                  break;

                case "redacted-reasoning":
                  // Redacted reasoning: only send if enabled
                  if (options?.sendReasoning) {
                    dataStreamChunk = `redacted_reasoning:${JSON.stringify({
                      data: chunkAny.data,
                    })}\n`;
                  }
                  break;

                case "reasoning-signature":
                  // Reasoning signature: only send if enabled
                  if (options?.sendReasoning) {
                    dataStreamChunk = `reasoning_signature:${JSON.stringify({
                      signature: chunkAny.signature,
                    })}\n`;
                  }
                  break;

                case "source":
                  // Source: only send if enabled
                  if (options?.sendSources) {
                    dataStreamChunk = `source:${JSON.stringify(
                      chunkAny.source
                    )}\n`;
                  }
                  break;

                case "file":
                  // File/Message annotation: type 8 (expects array)
                  dataStreamChunk = `8:[${JSON.stringify({
                    mimeType: chunkAny.mimeType,
                    data: chunkAny.base64,
                  })}]\n`;
                  break;

                case "tool-call-streaming-start":
                  // Tool call streaming start: type b
                  dataStreamChunk = `b:${JSON.stringify({
                    toolCallId: chunkAny.toolCallId,
                    toolName: chunkAny.toolName,
                  })}\n`;
                  break;

                case "tool-call-delta":
                  // Tool call delta: type c
                  dataStreamChunk = `c:${JSON.stringify({
                    toolCallId: chunkAny.toolCallId,
                    argsTextDelta: chunkAny.argsTextDelta,
                  })}\n`;
                  break;

                case "tool-call":
                  // Tool call: type 9
                  dataStreamChunk = `9:${JSON.stringify({
                    toolCallId: chunkAny.toolCallId,
                    toolName: chunkAny.toolName,
                    args: chunkAny.args,
                  })}\n`;
                  break;

                case "tool-result":
                  // Tool result: type a
                  dataStreamChunk = `a:${JSON.stringify({
                    toolCallId: chunkAny.toolCallId,
                    toolName: chunkAny.toolName,
                    result: chunkAny.result,
                    ...(chunkAny.handedOverTo && {
                      handedOverTo: chunkAny.handedOverTo,
                    }),
                  })}\n`;
                  break;

                case "step-start":
                  // Step start event: type f
                  dataStreamChunk = `f:${JSON.stringify({
                    messageId: chunkAny.messageId,
                  })}\n`;
                  break;

                case "step-finish":
                  // Step finish event: type e
                  dataStreamChunk = `e:${JSON.stringify({
                    finishReason: chunkAny.finishReason,
                    usage:
                      options?.sendUsage !== false
                        ? {
                            promptTokens: chunkAny.usage.promptTokens,
                            completionTokens: chunkAny.usage.completionTokens,
                          }
                        : undefined,
                    isContinued: chunkAny.isContinued,
                  })}\n`;
                  break;

                case "finish":
                  // Send finish event if not disabled: type d
                  if (options?.experimental_sendFinish !== false) {
                    const finishEvent = `d:${JSON.stringify({
                      finishReason: chunkAny.finishReason,
                      usage:
                        options?.sendUsage !== false
                          ? chunkAny.usage
                          : undefined,
                    })}\n`;
                    controller.enqueue(new TextEncoder().encode(finishEvent));
                  }
                  break;

                case "error":
                  // Error: type 3
                  const errorMessage = options?.getErrorMessage
                    ? options.getErrorMessage(chunkAny.error)
                    : "An error occurred";
                  dataStreamChunk = `3:"${errorMessage
                    .replace(/\\/g, "\\\\")
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, "\\n")
                    .replace(/\r/g, "\\r")
                    .replace(/\t/g, "\\t")}"\n`;
                  break;

                default:
                  // Skip unknown chunk types silently to maintain compatibility
                  break;
              }

              if (dataStreamChunk) {
                controller.enqueue(new TextEncoder().encode(dataStreamChunk));
              }
            }

            controller.close();
          } catch (error) {
            const errorMessage = options?.getErrorMessage
              ? options.getErrorMessage(error)
              : "An error occurred";
            controller.enqueue(
              new TextEncoder().encode(
                `3:"${errorMessage
                  .replace(/\\/g, "\\\\")
                  .replace(/"/g, '\\"')
                  .replace(/\n/g, "\\n")
                  .replace(/\r/g, "\\r")
                  .replace(/\t/g, "\\t")}"\n`
              )
            );
            controller.close();
          }
        },
      });

      return dataStream;
    };

    const toDataStreamResponse = (options?: SwarmToDataStreamOptions) => {
      return new Response(toDataStream(options), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Vercel-AI-Data-Stream": "v1",
        },
      });
    };

    return {
      finishReason: finishReasonPromise.promise,
      activeAgent: activeAgentPromise.promise,
      text: textPromise.promise,
      messages: allResponseMessagesPromise.promise,
      context: contextPromise.promise,
      textStream: textStream,
      fullStream: fullStream,
      toDataStream,
      toDataStreamResponse,
    };
  }

  /**
   * Return a read-only version of the context
   */
  public getContext() {
    return this.context as Readonly<SWARM_CONTEXT>;
  }

  /**
   * Update context, and receive a readonly version of it.
   * @param update
   */
  public updateContext(update: Partial<SWARM_CONTEXT>) {
    this.context = {
      ...this.context,
      ...update,
    };
    return this.context as Readonly<SWARM_CONTEXT>;
  }

  /**
   * Handle updating and overriding models configurations based on invocation options
   * @param invocationOptions
   * @private
   */
  private handleUpdatesAndOverrides(
    invocationOptions: SwarmInvocationOptions<SWARM_CONTEXT>
  ) {
    // Handle changing the active agent
    if (invocationOptions.setAgent) {
      this._activeAgent = invocationOptions.setAgent;
    }

    if (invocationOptions.messages) {
      this.messages = invocationOptions.messages;
    }
    // handle
    this.context = {
      ...this.context,
      ...invocationOptions.contextUpdate,
    };
  }

  /**
   * wrap the agent's tools to hide the swarmContext property that they can request to get access to the swarm's
   * context; so that the LLM doesn't see it and try to generate it. this requires modifying the JSON schema, and
   * wrapping the executor.
   * @param tools
   * @private
   */
  private wrapTools(
    tools: Record<string, AgentTool<SWARM_CONTEXT>> | undefined
  ): Record<string, CoreTool> | undefined {
    if (!tools) return undefined;

    // Map each tool into a CoreTool
    return Object.fromEntries(
      Object.entries(tools).map(
        ([toolName, agentTool]: [string, AgentTool<SWARM_CONTEXT>]): [
          string,
          CoreTool
        ] => {
          let parameters: AgentTool<SWARM_CONTEXT>["parameters"] =
            agentTool.parameters;
          let executor: CoreTool["execute"] = undefined;

          let functionWrapper:
            | ((
                args: z.infer<typeof parameters>,
                options: ToolExecutionOptions
              ) => Promise<typeof agentTool.execute>)
            | undefined;

          // Wrap tool to handle context updates if the function requests it in the return
          if (agentTool.type === "function") {
            functionWrapper = async (
              args: z.infer<typeof parameters>,
              options: ToolExecutionOptions
            ) => {
              const { result, context } = await agentTool.execute(
                args,
                options
              );

              if (context)
                this.context = {
                  ...this.context,
                  ...context,
                };
              return result;
            };
          }

          // If the tool requests the swarm's context, we don't want the LLM to generate it,
          //  so strip it from the tool call parameters and wrap the executor

          if (SWARM_CONTEXT_PROPERTY_NAME in agentTool.parameters.shape) {
            // Set the parameters for the tool so they omit the context; so that the LLM doesn't generate it
            parameters = agentTool.parameters.omit({
              [SWARM_CONTEXT_PROPERTY_NAME]: true,
            });

            // if there's an executor, wrap it with an executor that only receives the LLM-generated arguments
            //  (i.e. no context) and that then GETS the context of the swarm, and passed it along with the
            //  LLM generated-params (so both LLM params and swarm context) to the original executor.
            if (agentTool.execute) {
              executor = async (
                args: z.infer<typeof parameters>,
                options: ToolExecutionOptions
              ) => {
                const swarmContext = this.getContext();
                // Execute the agent tool with the arguments and the parameters
                return functionWrapper
                  ? functionWrapper(
                      {
                        ...args,
                        [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext,
                      },
                      options
                    )
                  : agentTool.execute!(
                      {
                        ...args,
                        [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext,
                      },
                      options
                    );
              };
            }
          } else {
            executor = functionWrapper;
          }

          // If the tool type is handover, ensure there's no executor so that generation stops and we can
          // stop the agent; we will run it manually
          if (agentTool.type === "handover") {
            executor = undefined;
          }

          // NOTE this looks more complicated (you'd think you could just pass an undefined executor) but you
          // cannot, so it has to be done this way.
          let wrappedTool: CoreTool;
          if (executor) {
            wrappedTool = tool({
              type: "function",
              description: agentTool.description,
              parameters: parameters,
              execute: executor,
            });
          } else {
            wrappedTool = tool({
              type: "function",
              description: agentTool.description,
              parameters: parameters,
            });
          }
          return [toolName, wrappedTool];
        }
      )
    );
  }

  public getMessages() {
    return this.messages as Readonly<Array<SwarmMessage>>;
  }
}
