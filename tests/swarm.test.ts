import { openai } from "@ai-sdk/openai";
import { type TextPart, type ToolCallPart } from "ai";
import { beforeEach, describe, expect, test } from "bun:test";
import z from "zod";
import { Swarm } from "../src";
import { Agent } from "../src/agent";
import { Hive } from "../src/hive";
import type { ExtendedTextStreamPart } from "../src/utils";

describe("Swarm Initialization tests", () => {
  test("Create a swarm with an agent should succeed", () => {
    let agent: Agent = new Agent({
      name: "Haiku writer",
      description: "Always responds in haikus",
      instructions: "Write a haiku in response to the user's request",
    });
    let swarm: Swarm = new Swarm({
      defaultModel: openai("gpt-4o-mini"),
      name: "Test Swarm",
      queen: agent,
      initialContext: {},
    });

    expect(() => {
      agent = new Agent({
        name: "Haiku writer",
        description: "Always responds in haikus",
        instructions: "Write a haiku in response to the user's request",
      });
    }).not.toThrowError();

    expect(() => {
      swarm = new Swarm({
        defaultModel: openai("gpt-4o-mini"),
        name: "Test Swarm",
        queen: agent,
        initialContext: {},
      });
    }).not.toThrowError();
  });
});

describe("Simple Swarm", async () => {
  interface SalesContext {
    topic: string | null;
    weather: string | null;
  }

  const salesAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: "Kyle the salesman",
    description: "Agent to answer sales queries",
    instructions:
      "You are a salesman for Salesforce. You answer all sales questions about salesforce to the best of your ability.",
  });
  const receptionistAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: "Receptionist",
    description: "A simple agent that answers user queries",
    instructions:
      "You help users talk to the person that they want to talk to by routing them appropriately.",
    tools: {
      get_current_weather: {
        type: "function",
        description: "Get the weather in a given city",
        parameters: z.object({
          city: z.string().describe("The city to get the weather for."),
          swarmContext: z.custom<SalesContext>(),
        }),
        execute: async ({ city, swarmContext }, options) => {
          return {
            result: "70 degrees fahrenheit and sunny",
            context: {
              topic: "the weather",
              weather: "70 degrees and sunny",
            },
          };
        },
      },
      transfer_to_sales: {
        type: "handover",
        description:
          "Transfer the conversation to a sales agent who can answer questions about sales",
        parameters: z.object({
          topic: z.string().describe("The topic of the sales conversation"),
        }),
        execute: async ({ topic }) => {
          return {
            agent: salesAgent,
            context: { topic },
          };
        },
      },
    },
  });

  const hive = new Hive<SalesContext>({
    queen: receptionistAgent,
    defaultModel: openai("gpt-4o-mini"),
    defaultContext: { topic: null, weather: null },
  });

  let swarm: Swarm<SalesContext>;

  beforeEach(() => {
    swarm = hive.spawnSwarm({});
  });

  test("Simple question should not trigger handoff", async () => {
    const result = await swarm.generateText({
      content: "Hi, how are you?",
    });

    expect(result.finishReason).toEqual("stop");
    expect(swarm.activeAgent.name).toEqual(receptionistAgent.name);
    expect(
      result.messages.filter((message) => message.role === "tool").length
    ).toEqual(0);
  });

  test("Asking for an agent should trigger a handoff", async () => {
    const result = await swarm.generateText({
      messages: [
        { role: "user", content: "Hi, how are you doing today?" },
        {
          role: "assistant",
          content: "I'm doing great, how can I help you today? ",
        },
        {
          role: "user",
          content: "I'd like to talk to someone about salesforce AI agents",
        },
      ],
    });

    expect(result.finishReason).toEqual("stop");
    expect(swarm.activeAgent.name).toEqual(salesAgent.name);

    const toolCalls = result.messages
      .filter((message) => message.role === "assistant")
      .filter((message) => typeof message.content !== "string")
      .map((message) =>
        (message.content as Array<TextPart | ToolCallPart>).flat()
      )
      .flat()
      .filter((part) => part.type === "tool-call")
      .map((part) => part.toolName);
    expect(toolCalls).toContain("transfer_to_sales");
  });

  test("Context should be updated by tool calls.", async () => {
    const result = await swarm.generateText({
      content: "Can I talk to sales about Salesforce AI Agents?",
      onStepFinish: async (stepFinish, context) => {
        expect(context).toBeDefined();
      },
    });
    expect(result.activeAgent.name).toEqual(salesAgent.name);
    expect(swarm.getContext().topic).toBeDefined();
  });

  test("Updating context should result in updated context in subsequent runs", async () => {
    let result = await swarm.generateText({
      content: "Can I talk to sales about Salesforce AI Agents?",
      onStepFinish: async (stepFinish, context) => {
        expect(context).toBeDefined();
      },
    });

    expect(result.context.topic).toBeDefined();
    swarm.updateContext({
      topic: "what does salesforce do?",
    });

    result = await swarm.generateText({
      content: "What does salesforce actually do",
      onStepFinish: async (stepFinish, context) => {
        expect(context.topic).toEqual("what does salesforce do?");
      },
    });
    expect(result.context.topic).toEqual("what does salesforce do?");
  });

  test("Tools should receive context not generated by tools", async () => {
    const result = await swarm.generateText({
      content: "What is the weather in New York??",
    });
    expect(result.activeAgent.name).toEqual(receptionistAgent.name);
    const toolCalls = result.messages
      .filter((message) => message.role === "assistant")
      .filter((message) => typeof message.content !== "string")
      .map((message) =>
        (message.content as Array<TextPart | ToolCallPart>).flat()
      )
      .flat()
      .filter((part) => part.type === "tool-call")
      .map((part) => part.toolName);

    expect(result.context.topic).toEqual("the weather"); // weather tool manually sets this
    expect(result.context.weather).toBeDefined();
    expect(toolCalls).toContain("get_current_weather");
  });
});

describe("Single-agent swarm streaming", async () => {
  const agent = new Agent({
    name: "Haiku writer",
    description: "Always responds in haikus",
    instructions: "Write a haiku in response to the user's request",
  });
  const swarm = new Swarm({
    defaultModel: openai("gpt-4o-mini"),
    name: "Test Swarm",
    queen: agent,
    initialContext: {},
  });

  test("Streaming text deltas should match finished text", async () => {
    const streamResult = swarm.streamText({
      content: "Write a haiku about dragonflies",
    });

    // Ensure that the stream result matches the text
    let text = "";
    for await (const token of streamResult.textStream) {
      text += token;
    }
    const textResult = await streamResult.text;
    expect(textResult).toEqual(text);
  });

  test("Streaming should have agent information on each chunk", async () => {
    const streamResult = swarm.streamText({
      content: "Write a haiku about dragonflies",
    });

    // Ensure that streamed chunks have the `type` field and have the agent's information on them
    for await (const chunk of streamResult.fullStream) {
      expect(chunk).toHaveProperty("type");
      expect(chunk).toHaveProperty("agent", {
        id: agent.uuid,
        name: agent.name,
      });
    }
  });
});

describe("Multi-agent swarm streaming", async () => {
  interface SalesContext {
    topic: string | null;
    weather: string | null;
  }

  const salesAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: "Kyle the salesman",
    description: "Agent to answer sales queries",
    instructions:
      "You are a salesman for Salesforce. You answer all sales questions about salesforce to the best of your ability.",
  });
  const receptionistAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: "Receptionist",
    description: "A simple agent that answers user queries",
    instructions:
      "You help users talk to the person that they want to talk to by routing them appropriately.",
    tools: {
      get_current_weather: {
        type: "function",
        description: "Get the weather in a given city",
        parameters: z.object({
          city: z.string().describe("The city to get the weather for."),
          swarmContext: z.custom<SalesContext>(),
        }),
        execute: async ({ city, swarmContext }, options) => {
          return {
            result: "70 degrees fahrenheit and sunny",
            context: {
              topic: "the weather",
              weather: "70 degrees and sunny",
            },
          };
        },
      },
      transfer_to_sales: {
        type: "handover",
        description:
          "Transfer the conversation to a sales agent who can answer questions about sales",
        parameters: z.object({
          topic: z.string().describe("The topic of the sales conversation"),
        }),
        execute: async ({ topic }) => {
          return {
            agent: salesAgent,
            context: { topic },
          };
        },
      },
    },
  });

  const hive = new Hive<SalesContext>({
    queen: receptionistAgent,
    defaultModel: openai("gpt-4o-mini"),
    defaultContext: { topic: null, weather: null },
  });

  let swarm: Swarm<SalesContext>;

  beforeEach(() => {
    swarm = hive.spawnSwarm({});
  });

  test("Tool calls should be streamed", async () => {
    const result = swarm.streamText({
      content: "What is the weather today in Dallas, TX?",
    });

    const chunks: Array<
      ExtendedTextStreamPart<any> & { agent: { id: string; name: string } }
    > = [];
    for await (const chunk of result.fullStream) {
      expect(chunk).toHaveProperty("agent");
      expect(chunk.agent).toEqual({
        id: receptionistAgent.uuid,
        name: receptionistAgent.name,
      });
      chunks.push(chunk);
    }

    const toolRelatedChunks = chunks.filter((c) => c.type.includes("tool"));

    expect(toolRelatedChunks.length).toBeGreaterThan(1);

    const toolStreamingStartChunk = toolRelatedChunks.find(
      (c) => c.type === "tool-call-streaming-start"
    );
    expect(toolStreamingStartChunk).toBeDefined();
    expect(toolStreamingStartChunk?.toolName).toEqual("get_current_weather");
    expect(toolStreamingStartChunk).not.toHaveProperty("handover");

    // make sure arguments match
    const toolCallDeltaArgs = toolRelatedChunks
      .filter((c) => c.type === "tool-call-delta")
      .reduce((accumulator, current, idx, values) => {
        return accumulator + current.argsTextDelta;
      }, "");

    const toolCall = toolRelatedChunks.find((c) => c.type === "tool-call");
    expect(toolCall?.args).toEqual(JSON.parse(toolCallDeltaArgs));

    const toolResults = toolRelatedChunks.find((c) => c.type === "tool-result");
    expect(toolResults?.result).toEqual("70 degrees fahrenheit and sunny");
  });

  test("Tool calls should match the active agent", async () => {
    const result = swarm.streamText({
      content: "I'd like to talk to someone about salesforce AI agents",
    });

    const chunks: Array<
      ExtendedTextStreamPart<any> & { agent: { id: string; name: string } }
    > = [];
    let handedOver: boolean = false;
    for await (const chunk of result.fullStream) {
      if (chunk.type === "finish" || chunk.type === "step-finish") continue;
      console.log(chunk);

      if (!handedOver) expect(chunk.agent.name).toEqual(receptionistAgent.name);
      else expect(chunk.agent.name).toEqual(salesAgent.name);

      if (chunk.type === "tool-result" && chunk.handedOverTo) handedOver = true;

      chunks.push(chunk);
    }
  });
});

describe("Swarm Data Stream Tests", () => {
  interface TestContext {
    topic: string | null;
    weather: string | null;
  }

  const testAgent: Agent<TestContext> = new Agent<TestContext>({
    name: "Test Agent",
    description: "A test agent for data stream testing",
    instructions:
      "You are a helpful assistant. Answer questions briefly and clearly.",
  });

  const toolAgent: Agent<TestContext> = new Agent<TestContext>({
    name: "Tool Agent",
    description: "Agent with tools for testing",
    instructions: "You help users with tools and then provide responses.",
    tools: {
      get_weather: {
        type: "function",
        description: "Get the weather for a city",
        parameters: z.object({
          city: z.string().describe("The city to get weather for"),
        }),
        execute: async ({ city }) => {
          return {
            result: `The weather in ${city} is sunny and 72°F`,
          };
        },
      },
    },
  });

  const handoverAgent: Agent<TestContext> = new Agent<TestContext>({
    name: "Handover Agent",
    description: "Agent that can transfer to other agents",
    instructions: "You help route users to the right agent.",
    tools: {
      transfer_to_tool_agent: {
        type: "handover",
        description: "Transfer to the tool agent",
        parameters: z.object({
          reason: z.string().describe("Reason for transfer"),
        }),
        execute: async ({ reason }) => {
          return {
            agent: toolAgent,
            context: { topic: reason },
          };
        },
      },
    },
  });

  let swarm: Swarm<TestContext>;

  beforeEach(() => {
    swarm = new Swarm<TestContext>({
      defaultModel: openai("gpt-4o-mini"),
      name: "Test Swarm",
      queen: testAgent,
      initialContext: { topic: null, weather: null },
    });
  });

  test("toDataStreamResponse should return a valid Response object", async () => {
    const result = swarm.streamText({
      content: "Hello, how are you?",
    });

    const response = result.toDataStreamResponse();

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Vercel-AI-Data-Stream")).toBe("v1");

    // Verify we can read the stream
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const decoder = new TextDecoder();
      let allData = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          allData += decoder.decode(value, { stream: true });
        }
      }

      // Should contain start event, text deltas, and finish event
      expect(allData).toContain("2:{}"); // start event
      expect(allData).toContain('0:"'); // text delta
      expect(allData).toContain("d:"); // finish event
    }
  });

  test("toDataStream should return a ReadableStream with proper data stream format", async () => {
    const result = swarm.streamText({
      content: "Say hello",
    });

    const dataStream = result.toDataStream();
    expect(dataStream).toBeInstanceOf(ReadableStream);

    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        allData += decoder.decode(value, { stream: true });
      }
    }

    // Should follow AI SDK data stream protocol
    expect(allData).toContain("2:{}"); // start event
    expect(allData).toContain('0:"'); // text delta events
    expect(allData).toContain("d:"); // finish event with usage
    expect(allData).toContain('"finishReason"');
    expect(allData).toContain('"usage"');
  });

  test("toDataStream should handle tool calls correctly", async () => {
    const swarmWithTools = new Swarm<TestContext>({
      defaultModel: openai("gpt-4o-mini"),
      name: "Tool Test Swarm",
      queen: toolAgent,
      initialContext: { topic: null, weather: null },
    });

    const result = swarmWithTools.streamText({
      content: "What's the weather in New York?",
    });

    const dataStream = result.toDataStream();
    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        allData += decoder.decode(value, { stream: true });
      }
    }

    // Should contain tool call events
    expect(allData).toContain("b:"); // tool-call-streaming-start
    expect(allData).toContain("c:"); // tool-call-delta
    expect(allData).toContain("9:"); // tool-call
    expect(allData).toContain("a:"); // tool-result
    expect(allData).toContain("get_weather");
  });

  test("toDataStream should handle handover correctly", async () => {
    const swarmWithHandover = new Swarm<TestContext>({
      defaultModel: openai("gpt-4o-mini"),
      name: "Handover Test Swarm",
      queen: handoverAgent,
      initialContext: { topic: null, weather: null },
    });

    const result = swarmWithHandover.streamText({
      content: "I need help with weather information",
    });

    const dataStream = result.toDataStream();
    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        allData += decoder.decode(value, { stream: true });
      }
    }

    // Should contain handover tool result with handedOverTo
    expect(allData).toContain("a:"); // tool-result
    expect(allData).toContain('"handedOverTo"');
    expect(allData).toContain("Tool Agent");
  });

  test("toDataStream with custom options should respect settings", async () => {
    const result = swarm.streamText({
      content: "Hello",
    });

    const dataStream = result.toDataStream({
      sendUsage: false,
      sendReasoning: false,
      sendSources: false,
      experimental_sendStart: false,
      experimental_sendFinish: false,
      getErrorMessage: (error) => `Custom error: ${error}`,
    });

    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        allData += decoder.decode(value, { stream: true });
      }
    }

    // Should not contain start event when disabled
    expect(allData).not.toContain("2:{}");
    // Should not contain finish event when disabled
    expect(allData).not.toContain("d:");
    // Should still contain text deltas
    expect(allData).toContain('0:"');
  });

  test("toDataStream should handle errors properly", async () => {
    // Create a swarm that will likely cause an error with invalid configuration
    const errorSwarm = new Swarm<TestContext>({
      defaultModel: openai("invalid-model" as any),
      name: "Error Test Swarm",
      queen: testAgent,
      initialContext: { topic: null, weather: null },
    });

    const result = errorSwarm.streamText({
      content: "This should cause an error",
    });

    const dataStream = result.toDataStream({
      getErrorMessage: (error) => "Custom error occurred",
    });

    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;
    let errorOccurred = false;

    // Add a timeout to prevent hanging
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Test timeout")), 8000)
    );

    try {
      await Promise.race([
        (async () => {
          while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
              allData += decoder.decode(value, { stream: true });
            }
          }
        })(),
        timeout,
      ]);
    } catch (error) {
      errorOccurred = true;
    }

    // Either the stream should contain an error event, or an error should be thrown
    const hasErrorEvent = allData.includes('3:"') || allData.includes("error");
    expect(errorOccurred || hasErrorEvent).toBe(true);
  });

  test("toDataStreamResponse should preserve custom options", async () => {
    const result = swarm.streamText({
      content: "Test message",
    });

    const response = result.toDataStreamResponse({
      sendUsage: false,
      sendReasoning: true,
      experimental_sendFinish: false,
    });

    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(response.headers.get("X-Vercel-AI-Data-Stream")).toBe("v1");

    // The options should be passed through to the underlying toDataStream
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let allData = "";
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          allData += decoder.decode(value, { stream: true });
        }
      }

      // Should not contain finish event when disabled
      expect(allData).not.toContain("d:");
    }
  });

  test("Data stream format should be compatible with AI SDK protocol", async () => {
    const result = swarm.streamText({
      content: "Generate a brief response",
    });

    const dataStream = result.toDataStream();
    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        chunks.push(chunk);
      }
    }

    const allData = chunks.join("");
    const lines = allData.split("\n").filter((line) => line.trim());

    // Verify each line follows the AI SDK data stream format
    for (const line of lines) {
      if (line.startsWith("0:")) {
        // Text delta - should be valid JSON string
        const jsonPart = line.slice(2);
        expect(() => JSON.parse(jsonPart)).not.toThrow();
      } else if (line.startsWith("2:")) {
        // Start event - should be valid JSON
        const jsonPart = line.slice(2);
        expect(() => JSON.parse(jsonPart)).not.toThrow();
      } else if (line.startsWith("d:")) {
        // Finish event - should contain valid usage data
        const jsonPart = line.slice(2);
        const parsed = JSON.parse(jsonPart);
        expect(parsed).toHaveProperty("finishReason");
        expect(parsed).toHaveProperty("usage");
      }
    }
  });
});
