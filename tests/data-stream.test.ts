import { openai } from "@ai-sdk/openai";
import { describe, expect, test } from "bun:test";
import z from "zod";
import { Agent, Swarm } from "../src";

describe("Data Stream Protocol Compatibility", () => {
  interface TestContext {
    topic: string | null;
  }

  const testAgent = new Agent<TestContext>({
    name: "Test Agent",
    description: "A test agent for data stream verification",
    instructions: "You are a helpful assistant.",
    tools: {
      test_tool: {
        type: "function",
        description: "A test tool",
        parameters: z.object({
          input: z.string().describe("Test input"),
        }),
        execute: async ({ input }) => ({
          result: `Processed: ${input}`,
        }),
      },
    },
  });

  const swarm = new Swarm<TestContext>({
    defaultModel: openai("gpt-4o-mini"),
    queen: testAgent,
    initialContext: { topic: null },
  });

  test("Data stream should use correct protocol format codes", async () => {
    const result = swarm.streamText({
      content: 'Use the test tool with input "hello"',
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

    // Verify the stream uses correct AI SDK v4+ protocol format codes
    const lines = allData.split("\n").filter((line) => line.trim());

    // Should contain proper format codes
    const hasTextDelta = lines.some((line) => line.startsWith("0:"));
    const hasStartEvent = lines.some((line) => line.startsWith("2:"));
    const hasFinishEvent = lines.some((line) => line.startsWith("d:"));

    expect(hasTextDelta).toBe(true);
    expect(hasStartEvent).toBe(true);
    expect(hasFinishEvent).toBe(true);

    // Should NOT contain old format codes
    expect(allData).not.toContain("12:"); // Old tool-call-streaming-start
    expect(allData).not.toContain("13:"); // Old tool-call-delta
    expect(allData).not.toContain("11:"); // Old tool-result

    // Tool calls should use new format codes if present
    if (allData.includes("test_tool")) {
      const hasNewToolStreamStart = lines.some((line) => line.startsWith("b:"));
      const hasNewToolDelta = lines.some((line) => line.startsWith("c:"));
      const hasNewToolResult = lines.some((line) => line.startsWith("a:"));

      // At least one of these should be true if tool was called
      expect(hasNewToolStreamStart || hasNewToolDelta || hasNewToolResult).toBe(
        true
      );
    }
  });

  test("Data stream should properly format annotation arrays", async () => {
    // This test ensures that type 8 (annotations) are properly formatted as arrays
    const result = swarm.streamText({
      content: "Hello world",
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

    // Check that any type 8 entries (annotations) are properly formatted as arrays
    const annotationLines = allData
      .split("\n")
      .filter((line) => line.startsWith("8:"));

    for (const line of annotationLines) {
      const content = line.slice(2); // Remove '8:' prefix
      expect(() => JSON.parse(content)).not.toThrow();
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  test("Data stream should properly escape error messages", async () => {
    // Test that error messages are properly escaped as JSON strings
    const errorSwarm = new Swarm<TestContext>({
      defaultModel: openai("invalid-model" as any),
      queen: testAgent,
      initialContext: { topic: null },
    });

    const result = errorSwarm.streamText({
      content: "This should error",
    });

    const dataStream = result.toDataStream({
      getErrorMessage: () => 'Test error with "quotes" and \n newlines',
    });

    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";
    let done = false;
    let hasError = false;

    try {
      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          allData += decoder.decode(value, { stream: true });
        }
      }
    } catch {
      hasError = true;
    }

    // Either we get an error in the stream or an exception
    const errorLines = allData
      .split("\n")
      .filter((line) => line.startsWith("3:"));

    if (errorLines.length > 0) {
      for (const line of errorLines) {
        const content = line.slice(2); // Remove '3:' prefix
        // Should be valid JSON string
        expect(() => JSON.parse(content)).not.toThrow();
      }
    } else {
      // If no error lines, we should have had an exception
      expect(hasError).toBe(true);
    }
  });
});
