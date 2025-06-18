import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { Agent, Swarm } from "./src";

// Define the context type for our agents
interface CustomerServiceContext {
  customerName?: string;
  issue?: string;
  priority?: "low" | "medium" | "high";
  resolution?: string;
}

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Check if OpenRouter API key is set
if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "⚠️ Warning: OPENROUTER_API_KEY environment variable is not set. Please set it to use Gemini 2.5 Pro reasoning features."
  );
}

// Create a general customer service agent using GPT-4o-mini
const customerServiceAgent = new Agent<CustomerServiceContext>({
  name: "Sarah - Customer Service Rep",
  description:
    "General customer service representative who handles initial inquiries",
  instructions: `You are a friendly customer service representative. 
  - Greet customers warmly and gather their name
  - For ANY technical issues (API, integration, webhooks, etc.), IMMEDIATELY transfer to the technical specialist using the transfer_to_technical tool
  - For billing issues, try to resolve them yourself using update_customer_info
  - Always be helpful and professional
  - When you identify a technical issue, call the transfer tool right away`,
  model: openai("gpt-4o-mini"), // Using GPT-4o-mini for general service
  tools: {
    transfer_to_technical: {
      type: "handover",
      description:
        "Transfer customer to technical specialist for complex technical issues",
      parameters: z.object({
        issue: z.string().describe("Description of the technical issue"),
        priority: z
          .enum(["low", "medium", "high"])
          .describe("Issue priority level"),
      }),
      execute: async ({ issue, priority }) => {
        return {
          agent: technicalSpecialistAgent,
          context: { issue, priority },
        };
      },
    },
    update_customer_info: {
      type: "function",
      description: "Update customer information in the system",
      parameters: z.object({
        customerName: z.string().describe("Customer's name"),
        issue: z.string().describe("Description of their issue"),
      }),
      execute: async ({ customerName, issue }) => {
        console.log(`📝 Updated customer info: ${customerName} - ${issue}`);
        return {
          result: `Customer information updated for ${customerName}`,
          context: { customerName, issue },
        };
      },
    },
  },
});

// Create a technical specialist agent using GPT-4o (more powerful model)
const technicalSpecialistAgent = new Agent<CustomerServiceContext>({
  name: "Alex - Technical Specialist",
  description: "Technical specialist who handles complex technical issues",
  instructions: `You are a technical specialist with deep expertise.
  - Analyze technical problems thoroughly
  - Provide detailed technical solutions
  - Ask specific technical questions when needed
  - Always explain solutions in a clear, step-by-step manner
  - Mark issues as resolved when complete`,
  model: openrouter("anthropic/claude-3.7-sonnet:thinking", {
    extraBody: {
      reasoning: {
        max_tokens: 250,
      },
    },
  }) as any, // Using Gemini Pro 1.5 which doesn't have reasoning chunks
  tools: {
    resolve_issue: {
      type: "function",
      description: "Mark a technical issue as resolved",
      parameters: z.object({
        resolution: z
          .string()
          .describe("Description of how the issue was resolved"),
      }),
      execute: async ({ resolution }) => {
        console.log(`✅ Issue resolved: ${resolution}`);
        return {
          result: `Issue has been resolved: ${resolution}`,
          context: { resolution },
        };
      },
    },
    escalate_to_engineering: {
      type: "function",
      description: "Escalate complex issues to engineering team",
      parameters: z.object({
        technicalDetails: z.string().describe("Detailed technical information"),
      }),
      execute: async ({ technicalDetails }) => {
        console.log(`🚨 Escalated to engineering: ${technicalDetails}`);
        return {
          result: `Issue escalated to engineering team with details: ${technicalDetails}`,
        };
      },
    },
  },
});

// Create the swarm with the customer service agent as the queen
const swarm = new Swarm<CustomerServiceContext>({
  name: "Customer Service Swarm",
  queen: customerServiceAgent,
  defaultModel: openai("gpt-4o-mini"),
  initialContext: {},
});

// Test function for streaming with agent handover
async function testStreamingOrchestration() {
  console.log("🚀 Starting Customer Service Swarm Test\n");
  console.log("=".repeat(50));

  try {
    // Start streaming with a technical issue that should trigger handover
    const streamResult = swarm.streamText({
      content:
        "Hi, I'm John Smith and I'm having trouble with my API integration. It keeps returning 401 errors even though I'm using the correct API key. This is a high priority issue that needs immediate technical assistance.",
    });

    console.log("📡 Streaming response...\n");

    // Track different types of events
    let currentAgent = "";
    let handoverOccurred = false;

    // Process the full stream to see all events
    for await (const chunk of streamResult.fullStream) {
      // Track agent changes
      if (chunk.agent.name !== currentAgent) {
        currentAgent = chunk.agent.name;
        console.log(`👤 Active Agent: ${currentAgent}`);
      }

      // Cast chunk to any to handle reasoning types that may not be in the type definition
      const chunkAny = chunk as any;
      switch (chunkAny.type) {
        case "text-delta":
          process.stdout.write(chunkAny.textDelta);
          break;

        case "reasoning":
          console.log(`\n🧠 Reasoning: ${chunkAny.textDelta}`);
          break;

        case "redacted-reasoning":
          console.log(`\n🧠 Redacted Reasoning:`, chunkAny.data);
          break;

        case "reasoning-signature":
          console.log(`\n🔐 Reasoning Signature:`, chunkAny.signature);
          break;

        case "tool-call-streaming-start":
          console.log(`\n🔧 Tool Call Started: ${chunkAny.toolName}`);
          break;

        case "tool-call-delta":
          // Show tool call argument streaming (usually JSON being built)
          process.stdout.write(".");
          break;

        case "tool-call":
          console.log(`\n🔧 Tool Call: ${chunkAny.toolName}`);
          console.log(`   Args:`, JSON.stringify(chunkAny.args, null, 2));
          break;

        case "tool-result":
          console.log(`\n✅ Tool Result: ${chunkAny.result}`);
          if (chunkAny.handedOverTo) {
            handoverOccurred = true;
            console.log(`🔄 Handover to: ${chunkAny.handedOverTo.name}`);
          }
          break;

        case "step-finish":
          console.log(`\n🏁 Step Finished: ${chunkAny.finishReason}`);
          if (chunkAny.usage) {
            console.log(
              `   Usage: ${chunkAny.usage.promptTokens} prompt + ${chunkAny.usage.completionTokens} completion tokens`
            );
          }
          break;

        case "finish":
          console.log(`\n🎯 Generation Finished: ${chunkAny.finishReason}`);
          if (chunkAny.usage) {
            console.log(`   Total Usage: ${chunkAny.usage.totalTokens} tokens`);
          }
          break;

        case "error":
          console.error(`\n❌ Error:`, chunkAny.error);
          break;

        default:
          // Log unknown chunk types for debugging
          console.log(`\n❓ Unknown chunk type:`, chunkAny.type);
          break;
      }
    }

    console.log("\n\n" + "=".repeat(50));
    console.log("📊 Final Results:");
    console.log("=".repeat(50));

    const [finalText, finalAgent, finalContext] = await Promise.all([
      streamResult.text,
      streamResult.activeAgent,
      streamResult.context,
    ]);

    console.log(`Final Agent: ${finalAgent.name}`);
    console.log(`Handover Occurred: ${handoverOccurred ? "Yes" : "No"}`);
    console.log(`Context:`, JSON.stringify(finalContext, null, 2));
    console.log(`\nComplete Response:\n${finalText}`);
  } catch (error) {
    console.error("❌ Error during streaming:", error);
  }
}

// Test function for data stream (AI SDK format)
async function testDataStreamOrchestration() {
  console.log("\n🌊 Testing Data Stream Format (AI SDK Compatible)\n");
  console.log("=".repeat(50));

  try {
    const streamResult = swarm.streamText({
      content:
        "I need help with a billing issue. My name is Jane Doe and I was charged twice for the same service.",
    });

    // Get the data stream in AI SDK format
    const dataStream = streamResult.toDataStream({
      sendUsage: true,
      sendReasoning: true, // Enable reasoning to see Gemini's thought process
    });

    const reader = dataStream.getReader();
    const decoder = new TextDecoder();
    let allData = "";

    console.log("📡 Raw AI SDK Data Stream Events:");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      allData += chunk;

      // Parse and display each event
      const lines = chunk.split("\n").filter((line) => line.trim());
      for (const line of lines) {
        try {
          if (line.startsWith("0:")) {
            const text = JSON.parse(line.slice(2));
            process.stdout.write(text);
          } else if (line.startsWith("2:")) {
            console.log("\n🚀 [START EVENT]");
          } else if (line.startsWith("d:")) {
            const finishData = JSON.parse(line.slice(2));
            console.log("\n🏁 [FINISH EVENT]", finishData);
          } else if (line.startsWith("reasoning:")) {
            const reasoning = line.slice(10);
            console.log("\n🧠 [REASONING]", reasoning);
          } else if (line.startsWith("redacted_reasoning:")) {
            const redactedReasoning = JSON.parse(line.slice(19));
            console.log("\n🧠 [REDACTED REASONING]", redactedReasoning);
          } else if (line.startsWith("reasoning_signature:")) {
            const reasoningSignature = JSON.parse(line.slice(20));
            console.log("\n🔐 [REASONING SIGNATURE]", reasoningSignature);
          } else if (line.startsWith("9:")) {
            const toolCall = JSON.parse(line.slice(2));
            console.log("\n🔧 [TOOL CALL]", toolCall.toolName);
          } else if (line.startsWith("11:")) {
            const toolResult = JSON.parse(line.slice(2));
            console.log("\n✅ [TOOL RESULT]", toolResult.toolName);
            if (toolResult.handedOverTo) {
              console.log("🔄 [HANDOVER]", toolResult.handedOverTo.name);
            }
          } else if (line.startsWith("finish_step:")) {
            const stepData = JSON.parse(line.slice(12));
            console.log("\n🏁 [STEP FINISH]", stepData);
          } else if (line.trim() && !line.startsWith("0:")) {
            // Log any other non-empty, non-text lines for debugging
            console.log("\n🔍 [OTHER EVENT]", line);
          }
        } catch (error) {
          console.error("\n❌ [PARSE ERROR]", { line, error: error.message });
        }
      }
    }

    console.log("\n\n📋 Complete AI SDK Data Stream:");
    console.log(allData);
  } catch (error) {
    console.error("❌ Error during data streaming:", error);
  }
}

// Test function for Response object (for web frameworks)
async function testDataStreamResponse() {
  console.log("\n🌐 Testing Data Stream Response (Web Framework Compatible)\n");
  console.log("=".repeat(50));

  try {
    const streamResult = swarm.streamText({
      content: "Can you help me troubleshoot why my webhooks aren't working?",
    });

    // Get a Response object that can be returned from API endpoints
    const response = streamResult.toDataStreamResponse({
      sendUsage: true,
    });

    console.log("📋 Response Headers:");
    for (const [key, value] of response.headers.entries()) {
      console.log(`  ${key}: ${value}`);
    }

    console.log("\n📡 Response Body Stream:");
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        process.stdout.write(chunk);
      }
    }
  } catch (error) {
    console.error("❌ Error during response streaming:", error);
  }
}

// Main execution
async function main() {
  console.log("🤖 Agent Swarm Orchestration Test");
  console.log("Testing two agents with different models:\n");
  console.log(
    `- ${customerServiceAgent.name}: ${
      customerServiceAgent.config?.model?.modelId || "gpt-4o-mini"
    }`
  );
  console.log(
    `- ${technicalSpecialistAgent.name}: ${
      technicalSpecialistAgent.config?.model?.modelId || "gpt-4o"
    }\n`
  );

  // Run all tests
  await testStreamingOrchestration();
  await testDataStreamOrchestration();
  await testDataStreamResponse();

  console.log("\n✅ All tests completed!");
}

// Run the tests
if (import.meta.main) {
  main().catch(console.error);
}

export {
  customerServiceAgent,
  swarm,
  technicalSpecialistAgent,
  testDataStreamOrchestration,
  testDataStreamResponse,
  testStreamingOrchestration,
};
