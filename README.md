# Swarm 🐝🐝🐝 

Swarm is a powerful, flexible, and model-agnostic library for creating and managing multi-agent AI systems. It allows 
you to create swarms of AI agents that can collaborate, hand off tasks, and maintain shared context.

This package is loosely based off of [OpenAI Swarm](https://github.com/openai/swarm), but please note that APIs are not 
identical, and they are not intended to be. This package is intended to provide the same functionality, 
but with better patterns, additional features, and modifications that fix some of the inherent 
issues with OpenAI's design. More about this in the [key concepts](#key-concepts) section below.

This library is _not_ opinionated about the LLM that you use. Since it is built on top of the 
[Vercel AI SDK](https://sdk.vercel.ai), it allows you to use any LLM or LLMs that you want. 

One of the design concerns for this library is optimizing for low latency in realtime multimodal applications, e.g. 
[Pipecat](https://www.pipecat.ai/) applications and other multimodal, multi-component applications. 
This library is _not_ strongly opinionated for such applications, but many defaults reflect the philosophy that statefulness is a reality and therefore a useful default for LLM applications, and LLM latency is a critical concern for user-facing apps

# Table of Contents

1. [Installation](#installation)
2. [Key Concepts](#key-concepts)
3. [Usage](#usage)
4. [API Reference](#api-reference)
5. [Examples](#examples)
6. [Changelog](#changelog)


# Installation

```bash
npm install @calebrussel77/swarm
```

**Note**: This package requires `ai` version 4.3.16 or higher for proper `useChat` compatibility.

# Key Concepts
- **Agent**: An individual AI entity with specific capabilities and instructions. Each agent has a unique system prompt 
or prompt template and a set of tools. 
- **Swarm**: A collection of agents working together to accomplish tasks.
- **Hive**: A factory for creating swarms with shared configuration.
- **Context**: Shared information that can be updated and accessed by agents within a swarm. 
- **Handover**: Transferring control from one agent to another; achieved by a tool call.

## Agents
Agents are defined using the `Agent` class. By design, agents are stateless. 
Each agent has a name, a description, and a set of tools. An agent also have additional configuration 
properties such as a `LanguageModel` to use that's different from the swarm's default, for example if you need a 
smarter, faster, or more specialized LLM for a given task. 

Each agent's `instructions` should either be a string, a nunjucks template string that receives the swarm's context, or a function that receives the
context object for the swarm and returns a string. This creates a reasonable amount of flexibility for your agent's 
prompt, but doesn't force you into patterns that you may not need.

## Swarm
Unlike an agent, a `Swarm` is stateful by default. This is _divergent from OpenAI's pattern_, but is useful in a variety
of cases, including in realtime applications (e.g. voice) or situations where low latency is critical. For example, once
a response is generated and presented to a user (e.g. asking for feedback or more info for a tool call),
the last-active agent remains active. Once additional user input is received, the new user input can be passed to the 
swarm without incurring additional unnecessary handovers.  

While stateful behavior is the default, it can be avoided by passing in a new list of messages and the agent to 
activate as the entrypoint with each invocation. More information on this will be provided in the API documentation.

Each hive and each swarm has a `queen`. Technically speaking, the queen is just the entrypoint to the swarm, or the 
first agent that will be executed. It may never need to be executed again depending on your swarm's structure, but for
many use-cases the `queen` will end up functioning as a type of orchestrator or router agent that handles dispatching 
other agents, processing their input, and "managing" the swarm, hence the name.


Each swarm has a `context` object which provides a type of global state across invocations. 
Agents in the swarm can update the context with tool calls and handovers, and the swarm's context is passed in as a
template to each agent's instructions during rendering with each swarm invocation.

> [!IMPORTANT]
> When `generateText` or `streamText` are used, the swarm will generate and process tool calls and handovers until a text
> response is generated.

Multiple subsequent tool calls and handovers in a row can create latency before any text is generated for the user. 

> [!TIP]
> When `streamText` is used, the name of the tool that is called as well as the agent calling it will be available in 
> the stream. Use this to provide feedback to users.

Though streaming is more difficult to handle on the client side, it can allow you to
provide user feedback or take actions as new information becomes available, creating less latency, better UX, and 
lower time-to-interactivity.

## Hive 
A `Hive` can be thought of as a stateless factory for creating swarms (which are stateful-by-default). For applications 
which use swarms statelessly, hives are unnecessary.

## Handover 
A handover is when one agent in the swarm transfers control of execution to another agent. handovers are achieved through
special tool calls that return another agent. Like traditional tool calls, a handover tool call can still have execution 
logic; and both regular and handover tool calls can update the swarm's `context` object.

## Hallucinations
OpenAI's swarm framework is described as an educational tool, rather than a production-ready framework. One of the 
reasons for this is because the entire conversation history across handovers, including tools and tool results is 
available to each agent, and LLMs are in-context learners.

Because the currently-executing can see messages in the conversation historyfrom other agents which are unrelated to 
their role, they can get confused and start to blend roles. 
Additionally, swarm's design is prone to tool hallucination because the currently-executing agent can see tool calls 
from all the other agents, even for tools which are not available to it.

This framework provides several options and patterns to avoid these issues. 
# Usage

## Creating an Agent

```typescript
import { Agent } from 'agentswarm';
import { anthropic } from '@ai-sdk/anthropic';

const salesAgent = new Agent<SalesContext>({
    name: 'Sales Agent',
    description: 'Handles sales-related queries',
    instructions: 'You are a sales representative for our company responsible for selling...',
    tools: {
        // Define tools here
    },
    model: anthropic('claude-3-haiku'), // overrides the Hive's default model for this agent
});
```

## Creating a Hive

```typescript
import { Hive } from 'agentswarm';
import { openai } from '@ai-sdk/openai';

interface SalesContext {
    topic: string | null 
    weather: string | null
}

const hive = new Hive<SalesContext>({
  queen: receptionistAgent, // "entrypoint" to the swarm; often the "orchestrator"
  defaultModel: openai('gpt-4o-mini'), // for agents that don't specify a model
  defaultContext: { topic: null, weather: null },
});
```

## Spawning a Swarm

```typescript
const swarm = hive.spawnSwarm();
```

## Using the Swarm

```typescript
const result = await swarm.generateText({
  content: 'Can I talk to someone about your B2B SaaS products?'
});

console.log(result.text);
console.log(result.activeAgent.name);
console.log(result.context);
```

## Creating a swarm directly
```typescript
const swarm = new Swarm({
    defaultModel: openai('gpt-4o-mini'),
    name: 'Test Swarm',
    queen: agent,
    initialContext: {}
})
```

# API Reference

## Agent

```typescript
new Agent<SWARM_CONTEXT>(options: AgentOptions<SWARM_CONTEXT>)
```
> [!IMPORTANT]
> Note that `SWARM_CONTEXT` defaults to `any` if a template value is not provided. Be careful! 
Contexts should be JSON-serializable.

### Agent Options `AgentOptions<SWARM_CONTEXT>`

| Name | Type | Description |
|------|------|-------------|
| `name` | `string` | The agent's name; used in handover |
| `description` | `string` | A description for the agent |
| `instructions` | `string \| ((context: SWARM_CONTEXT) => string)` | A prompt string, prompt nunjucks template, or prompt builder function. The swarm's context object will be passed in to the template or to the builder function. |
| `tools` | `Record<string, AgentTool<SWARM_CONTEXT>>` | The tools available to the agent. Each key should be the `name` of the tool, and the value is the tool or handover tool. |
| `toolChoice` | `CoreToolChoice<any>` | Force the agent to call one of the provided tools, or to call a specific tool. Useful when you want to force the agent to call a tool and then return handover back to the `queen` / router agent without generating text, since the first text response from the LLM will return the result of the user. |
| `model` | `LanguageModel (optional)` | The LLM to use; defaults to whatever the default LLM is for the swarm that's executing the agent. |
| `maxTurns` | `number (optional)` | Max number of iterative calls of tool calls & tool execution; use it to prevent infinite tool call loops. |
| `temperature` | `number (optional)` | Set the LLM's temperature |

### Agent tool `AgentTool<SWARM_CONTEXT>`
`AgentTool` is a wrapper on the AI SDK's native `tool`/`CoreTool` types that represents a callable tool that 
performs some execution, that hands off execution to the next agent, that updates the context of the swarm, or some 
combination thereof. 

| Property      | Type                                                                         | description                                                                                                                    |
|---------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| `type`        | `'function' \| 'handover'`                                                   | indicates whether the tool is a normal tool, or should transfer execution to another agent                                     |
| `description` | `string`                                                                     | information about what the tool does and when it should be called                                                              |
| `parameters`  | `z.AnyZodObject`                                                             | a zod schema describing the shape of the parameters; use the magic `swarmContext` key to request access to the swarm's context |
| `execute`     | `(parameters, options) => Promise<({result: string} \| {agent: Agent}) & {context?: Partial<SWARM_CONTEXT>}>` | an async executor for the tool. The shape of `parameters` is inferred from the zod schema.|

The wrapping of the AI SDK's native `tool` with `AgentTool` allows us to achieve a couple of things:
- distinguish between function tools and handover tools; and properly execute handovers on the client side
- allow tools to request access to the swarm's context at execution-time through the `parameters` object 
in a type-safe way, _without_ passing the swarm context parameter key to the LLM, since we don't want the LLM to 
try to generate (hallucinate) the context. The `swarmContext` magic parameter is stripped before the tool is passed to the
LLM
- allow tools to update the swarm's context after execution using the optional `context?: Partial<SWARM_CONTEXT>` key 
in the tool executor's return value

The simplest implementation of a tool specifies `type: 'tool'` and returns a tool result in the executor. This will 
behave like a normal tool
```typescript
new Agent({
    name: 'Weather agent',
    description: 'Gets the weather',
    tools: {
        get_current_weather: {
            type: 'function',
            description: 'Get the weather in a given city',
            parameters: z.object({
                city: z.string().describe('The city to get the weather for.'),
            }),
            execute: async ({city}, options) => {
                console.log(`Executing weather tool.`)
                return {
                    result: "70 degrees fahrenheit and sunny",
                }
            }
        },
    }
})
```

A handover tool specifies `type: 'handover'`, and will result in the active agent being transferred to the specified agent before 
swarm execution continues. Make sure to return an agent!
```typescript
new Agent({
    name: 'receptionist',
    description: 'a receptionist that handles routing conversations and calls',
    tools: {
        transfer_to_weatherman: {
            type: 'handover', // type: 'handover' is a framework level abstraction and will be converted under the hood
            description: 'Transfer the conversation to weatherman',
            parameters: z.object({}),
            execute: async () => {
                return {
                    agent: salesAgent, // return an `agent` rather than a `result`
                }
            }
        }
    }
})
```

> [!TIP]
> The swarm's context isn't just for system prompts! Tools can request access 
> to the swarm's context, and both regular and handover tools can update it.

Tools can access the swarm's context using the magic `swarmContext` key in the `parameters` object. If this key is 
specified, the tool's `execute` method will receive the current value of the swarm's context. 

Similarly, a tool can update the swarm context by returning a `context` update in the object returned by `execute` - 
the context object should be a `Partial<SWARM_CONTEXT>` and will be merged into the swarm context after the tool's 
execution. It can be used to set (and to unset!) keys on the context.

This can be a useful way to allow agents to pass messages, values, or even instructions to each other!

```typescript
interface SalesContext {
    topic: string | null
    weather: string | null
}
// Answers questions in text - as soon as text is generated it will be returned to the user!
const salesAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: 'Kyle the salesman',
    description: 'Agent to answer sales queries',
    // `topic` in the template will be filled in from the context
    instructions: 'You are a salesman for Salesforce. ' +
        'You answer all sales questions about salesforce to the best of your ability.' +
        'You are talking to a customer about {{topic}}, a salesforce product'
    
})

const receptionistAgent: Agent<SalesContext> = new Agent<SalesContext>({
    name: 'Receptionist',
    description: 'A simple agent that answers user queries',
    instructions: 'You help users talk to the person that they want to talk to by routing them appropriately.',
    tools: {
        get_current_weather: {
            type: 'function',
            description: 'Get the weather in a given city',
            parameters: z.object({
                city: z.string().describe('The city to get the weather for.'),
                // magic parameter to request access to swarm context
                swarmContext: z.custom<SalesContext>()
            }),
            // when swarm context is requested in the parameters, it can be accessed here!
            execute: async ({city, swarmContext}, options) => {
                console.log(`Swarm context:`, swarmContext)
                // Return an object that includes a result for the tool call, and a context update.
                return {
                    result: "70 degrees fahrenheit and sunny",
                    context: {
                        weather: '70 degrees and sunny'
                    }
                }
            }
        },
        transfer_to_sales: {
            type: 'handover',
            description: 'Transfer the conversation to a sales agent who can answer questions about sales',
            parameters: z.object({
                topic: z.string().describe('The topic of the sales conversation')
            }),
            execute: async ({topic}) => {
                return {
                    agent: salesAgent,
                    // update the context with the information that the sales agent will need in its' instructions.
                    context: {topic}
                }
            }
        }
    }

})
```

## Hive

```typescript
new Hive<HIVE_CONTEXT>(options: HiveOptions<HIVE_CONTEXT>)
```

### Hive Options `HiveOptions<HIVE_CONTEXT>`

| Name | Type | Description |
|------|------|-------------|
| `defaultModel` | `LanguageModel (optional)` | The default language model to be used by agents in the swarm if not specified individually |
| `queen` | `Agent<HIVE_CONTEXT>` | The initial agent (often an orchestrator) that serves as the entry point for the swarm |
| `defaultContext` | `HIVE_CONTEXT (optional)` | The default context object to be used when spawning new swarms |

### Methods
#### `spawnSwarm`
- `spawnSwarm(options?: HiveCreateSwarmOptions<HIVE_CONTEXT>): Swarm<HIVE_CONTEXT>` - creates a swarm based off the hive, 
with the ability to override certain values if desired

## Swarm

```typescript
new Swarm<SWARM_CONTEXT>(options: SwarmOptions<SWARM_CONTEXT>)
```

### Swarm Options `SwarmOptions<SWARM_CONTEXT>`

| Name | Type | Description                                                                                                                 |
|------|------|-----------------------------------------------------------------------------------------------------------------------------|
| `defaultModel` | `LanguageModel (optional)` | The default language model to be used by agents in the swarm if not specified individually                                  |
| `queen` | `Agent<SWARM_CONTEXT>` | The initial agent (often an orchestrator) that serves as the entry point for the swarm                                      |
| `initialContext` | `SWARM_CONTEXT` | The initial context object for the swarm                                                                                    |
| `messages` | `Array<SwarmMessage> (optional)` | Initial messages for the swarm, if any                                                                                      |
| `name` | `string (optional)` | A name for the swarm instance                                                                                               |
| `maxTurns` | `number (optional)` | Maximum number of turns (tool call & execution iterations) allowed in a single invocation; use to prevent infinite loops    |
| `returnToQueen` | `boolean (optional)` | Whether to return control to the queen agent after each interaction, or if the currently-active agent should remain active. |

> [!NOTE]
> A `SwarmMessage` is extended from `CoreMessage` in the AI SDK, with the exception that each `CoreAssistantMessage` has 
> a `sender` property set to the `name` of the `agent` in the swarm that generated it.

### Methods

#### `generateText`
```typescript
generateText(options: SwarmInvocationOptions<SWARM_CONTEXT>): Promise<GenerateTextResult>
```
Generate text with the swarm. Options:

| Property | Type | Description                                                                                                                                         |
|----------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `contextUpdate` | `Partial<SWARM_CONTEXT>` | Optional. Partial update to the swarm context.                                                                                                      |
| `setAgent` | `Agent<SWARM_CONTEXT>` | Optional. Sets a specific agent for the swarm invocation, overriding the currently active agent                                                     |
| `maxTurns` | `number` | Optional. Maximum number of turns allowed for the swarm invocation.                                                                                 |
| `returnToQueen` | `boolean` | Optional. Determines if control of the swarm should be returned to the queen after completion; overrides the property of the same name on the swarm |
| `onStepFinish` | `(event: StepResult<any>, context: SWARM_CONTEXT) => Promise<void> \| void` | Optional. Callback function executed after each step finishes.                                                                                      |
| `content` | `UserContent` | Required if `messages` is not provided. The content for the swarm invocation.                                                                       |
| `messages` | `Array<SwarmMessage>` | Required if `content` is not provided. An array of swarm messages for the invocation.                                                               |

Returns: `GenerateTextResult` (type from the [AI SDK](https://sdk.vercel.ai/docs/reference/ai-sdk-core/generate-text))

Notes: 
- The `content` and `messages` properties are mutually exclusive. You must provide either `content` or `messages`, but not both.
By default, you should probably only need to set one of these.
- Swarms can be used in a stateless manner by always setting the `messages` array rather than `content`, and by always setting `returnToQueen` or using `setAgent`

#### `streamText`
```typescript 
streamText(options: SwarmInvocationOptions<SWARM_CONTEXT> & SwarmStreamingOptions): {
    finishReason:  Promise<LanguageModelV1FinishReason>,
    activeAgent: Promise<Agent>,
    text: Promise<string>,
    messages: Promise<Array<SwarmMessage>>,
    context: Promise<SWARM_CONTEXT>,
    textStream: AsyncIterableStream<string>,
    fullStream:  AsyncIterableStream<ExtendedTextStreamPart<any>>
}
```

Stream text and tool calls from the stream. 
`SwarmInvocationOptions & SwarmStreamingOptions`:

| Property | Type | Description                                                                                                                                         |
|----------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `contextUpdate` | `Partial<SWARM_CONTEXT>` | Optional. Partial update to the swarm context.                                                                                                      |
| `setAgent` | `Agent<SWARM_CONTEXT>` | Optional. Sets a specific agent for the swarm invocation, overriding the currently active agent                                                     |
| `maxTurns` | `number` | Optional. Maximum number of turns allowed for the swarm invocation.                                                                                 |
| `returnToQueen` | `boolean` | Optional. Determines if control of the swarm should be returned to the queen after completion; overrides the property of the same name on the swarm |
| `onStepFinish` | `(event: StepResult<any>, context: SWARM_CONTEXT) => Promise<void> \| void` | Optional. Callback function executed after each step finishes.                                                                                      |
| `content` | `UserContent` | Required if `messages` is not provided. The content for the swarm invocation.                                                                       |
| `messages` | `Array<SwarmMessage>` | Required if `content` is not provided. An array of swarm messages for the invocation.                                                               |
| `experimental_toolCallStreaming` | `boolean (optional)` | Whether to enable experimental tool call streaming. Enabled by default unless explicitly disabled by setting to `false` |

Notes:
- The `content` and `messages` properties are mutually exclusive. You must provide either `content` or `messages`, but not both.
  By default, you should probably only need to set one of these.
- It is recommended to keep `experimental_toolCallStreaming` enabled; as it will allow you to read the name of the function 
that is being called as soon as the call begins; this can be very useful in realtime or latency-critical applications so
that you can take actions or provide feedback to the end-user about what the agent(s) are doing.

Return value:
> [!IMPORTANT]
> Unlike `Swarm.generateText`, this method returns immediately. Promise values resolve once the swarm has finished
> generating.

| Property | Type | Description                                                                                                                                                                               |
|----------|------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `finishReason` | `Promise<LanguageModelV1FinishReason>` | A promise that resolves to the final finish reason of the final agent that executes. Type is taken from the AI SDK                                                                        |
| `activeAgent` | `Promise<Agent>` | A promise that resolves to the agent that is active after streaming finishes. If `returnToQueen` is set, this will always be the queen. Otherwise, it will be whatever the last agent was |
| `text` | `Promise<string>` | A promise that resolves to the text generated at the end of the swarm's generation. |
| `messages` | `Promise<SwarmMessage>` | A promise that resolves to the messages generated by the swarm duriung streaming | 
| `context` | `Promise<SWARM_CONTEXT>` | A promise that resolves to the state of the swarm's context once the swarm has finished streaming |
| `textStream` | `AsyncIterableStream<string>` | Async iterable stream that yields the text chunks generated by the LLM once text (rather than tool calls) is being generated |
| `fullStream`| `AsyncIterableStream<ExtendedTextStreamPart<any>>` | Async iterable stream that contains the individual deltas for streaming, including text deltas, tool deltas, the finished tool call and tool results. See `streamText` in the AI SDK for details; note that `experimental_toolCallStreaming` is enabled by default. |

`ExtendedTextStreamPart` is etended from the [AI SDK's `TextStreamPart`](https://sdk.vercel.ai/docs/reference/ai-sdk-core/stream-text#full-stream.text-stream-part),
with several important additions:
1. Each delta has an `agent` key set to an object (`agent: { name: string, id: string }`) containing the `id` (`Agent.uuid`) and `name` (`Agent.name`) of the 
agent that generated the delta. This allows you to easily determine which agent is calling tools or generating text 
during stream processing; and can be very useful in real-time applications. 
2. A `TextStreamPart` with `{type: 'tool-result'}` will be included in streams for handovers, and in addition to the 
`agent` key described above which describes which agent was responsible for the delta, has a `handedOverTo` property 
indicating which agent the handover tool is transferring control to. The structure (`handedOverTo?: { name: string, id: string }`) 
is the same as for `agent`.

In both cases, the `Agent`'s `name` and `id` are used rathern than the `Agent` itself to preserve JSON-serializability.


#### `getContext`
```typescript 
getContext(): Readonly<SWARM_CONTEXT>
```
Retrieve the Swarm's context

#### `updateContext`
```typescript 
updateContext(update: Partial<SWARM_CONTEXT>): Readonly<SWARM_CONTEXT>
```
Force-update the swarm's context external to any agent interactions. 

# Examples

## Creating a Simple Sales Swarm

```typescript
import { Agent, Hive, Swarm } from 'agentswarm';
import { openai } from '@ai-sdk/openai';
import z from 'zod';

interface SalesContext {
  topic: string | null;
  weather: string | null;
}

const salesAgent = new Agent<SalesContext>({
  name: 'Sales Agent',
  description: 'Handles sales-related queries',
  instructions: 'You are a sales representative for our company trying to sell {{topic}}',
});

const receptionistAgent = new Agent<SalesContext>({
  name: 'Receptionist',
  description: 'Routes user queries to appropriate agents',
  instructions: 'You help users by routing them to the appropriate agent...',
  tools: {
    transfer_to_sales: {
      type: 'handover',
      description: 'Transfer to sales agent',
      parameters: z.object({
        topic: z.string().describe('Sales topic'),
      }),
      execute: async ({ topic }) => ({
        agent: salesAgent,
        context: { topic },
      }),
    },
  },
});

const hive = new Hive<SalesContext>({
  queen: receptionistAgent,
  defaultModel: openai('gpt-4o-mini'),
  defaultContext: { topic: null, weather: null },
});

const swarm = hive.spawnSwarm();

const result = await swarm.generateText({
  content: 'I want to learn about your product pricing.',
});

console.log(result.text);
console.log(result.activeAgent.name);
console.log(result.context);
```

## Using with Next.js and useChat

### API Route (`app/api/chat/route.ts`)

```typescript
import { openai } from '@ai-sdk/openai';
import { convertToCoreMessages } from 'ai';
import { Agent, Swarm } from 'agentswarm';
import z from 'zod';

interface ChatContext {
  topic: string | null;
  userInfo: string | null;
}

// Define your agents
const supportAgent = new Agent<ChatContext>({
  name: 'Support Agent',
  description: 'Handles customer support queries',
  instructions: 'You are a helpful customer support agent. {{topic ? `You are discussing: ${topic}` : ""}}',
});

const salesAgent = new Agent<ChatContext>({
  name: 'Sales Agent', 
  description: 'Handles sales and product inquiries',
  instructions: 'You are a sales representative. Help customers understand our products and pricing.',
});

const routerAgent = new Agent<ChatContext>({
  name: 'Router',
  description: 'Routes conversations to appropriate agents',
  instructions: 'You help route customers to the right department.',
  tools: {
    transfer_to_support: {
      type: 'handover',
      description: 'Transfer to customer support for technical issues',
      parameters: z.object({
        issue: z.string().describe('Description of the support issue'),
      }),
      execute: async ({ issue }) => ({
        agent: supportAgent,
        context: { topic: issue },
      }),
    },
    transfer_to_sales: {
      type: 'handover',
      description: 'Transfer to sales for product and pricing questions',
      parameters: z.object({
        interest: z.string().describe('What the customer is interested in'),
      }),
      execute: async ({ interest }) => ({
        agent: salesAgent,
        context: { topic: interest },
      }),
    },
  },
});

// Create the swarm
const swarm = new Swarm<ChatContext>({
  defaultModel: openai('gpt-4o-mini'),
  queen: routerAgent,
  initialContext: { topic: null, userInfo: null },
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Convert useChat messages to Core messages
  const coreMessages = convertToCoreMessages(messages);

  const result = swarm.streamText({
    messages: coreMessages,
  });

  return result.toDataStreamResponse();
}
```

### Client Component (`app/page.tsx`)

```typescript
'use client';

import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map((message) => (
        <div key={message.id} className="whitespace-pre-wrap">
          <strong>{message.role === 'user' ? 'User: ' : 'AI: '}</strong>
          {message.content}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
          disabled={isLoading}
        />
      </form>
    </div>
  );
}
```

### Alternative: Using with Custom Data Stream

If you need custom data alongside the messages:

```typescript
// API Route with custom data
export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = swarm.streamText({
    messages: convertToCoreMessages(messages),
  });

  return result.toDataStreamResponse({
    sendUsage: true, // Include token usage
    experimental_sendFinish: true, // Include finish events
  });
}
```

```typescript
// Client with data access
'use client';

import { useChat } from '@ai-sdk/react';

export default function ChatWithData() {
  const { messages, input, handleInputChange, handleSubmit, data } = useChat();

  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {/* Display any custom data */}
      {data && (
        <pre className="text-xs bg-gray-100 p-2 rounded">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

      {messages.map((message) => (
        <div key={message.id} className="whitespace-pre-wrap">
          <strong>{message.role === 'user' ? 'User: ' : 'AI: '}</strong>
          {message.content}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input
          className="fixed bottom-0 w-full max-w-md p-2 mb-8 border border-gray-300 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={handleInputChange}
        />
      </form>
    </div>
  );
}
```

## Streaming

```typescript
const result = swarm.streamText({
    content: 'I\'d like to talk to someone about salesforce AI agents'
})


let handedOver: boolean = false
let activeAgentName: string = agent.name
for await (const chunk of result.fullStream) {
    if (chunk.type === 'tool-result' && chunk.handedOverTo) {
        handedOver = true
        console.log(`Handover executed to agent ${chunk.handedOverTo.name}!`)
    }
    if (chunk.type === 'tool-call-streaming-start') {
        console.log(`Agent ${chunk.agent.name} is calling ${chunk.toolName}; arguments are being generated`)
    }
    if (chunk.agent.name !== activeAgentName) {
        console.log(`Active agent changed:`, chunk.agent.name) 
        activeAgentName = chunk.agent.name
    }
}

let streamedText = ''
for await (const textChunk of result.textStream) {
    // chunks of `textStream` are just strings :)
    streamedText += textChunk
}
streamedText === await result.text // true 

```

# Changelog

## [0.1.2] - 2024-01-xx

### Fixed

- **Data Stream Protocol Compatibility**: Fixed `"data" parts expect an array value.` error when using with Vercel AI SDK's `useChat` hook
  - Corrected stream part type codes to match AI SDK v4+ protocol:
    - Tool call streaming start: `12:` → `b:`
    - Tool call delta: `13:` → `c:`
    - Tool result: `11:` → `a:`
    - Error events: `e:` → `3:`
    - Step events: Updated to proper format codes
  - Fixed file/annotation parts to use proper array format: `8:[...]\n`
  - Enhanced error message escaping for proper JSON string format
  - Updated tests to reflect correct stream protocol format

### Improved

- Added comprehensive Next.js examples with `useChat` integration
- Enhanced README with proper installation instructions and compatibility notes
- Added complete API route and client component examples

## [0.1.1] - 2024-01-xx

### Initial Release

- Core swarm functionality with multi-agent orchestration
- Support for agent handovers and context sharing
- Tool calling and execution framework
- Streaming and non-streaming text generation
- TypeScript support with full type safety
