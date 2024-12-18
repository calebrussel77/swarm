import z from 'zod'
import type {CoreMessage, LanguageModelV1} from 'ai'
import {openai} from '@ai-sdk/openai'
import {Agent} from '../agent'
import {jsonValueSchema} from './common.schemas'
import type {SwarmMessage} from '../types'

export const swarmOptionsSchema = z.object({
    defaultLanguageModel: z.custom<LanguageModelV1>()
        .default(openai('gpt-4o-mini'))
        .describe('The default language model for the swarm; used if you do not specify one for the agent.'),
    messages: z.array(z.custom<SwarmMessage>())
        .default([])
        .describe('The messages in the conversation'),
    leader: z.custom<Agent>((agent) => agent instanceof Agent, 'Swarm leader must be an agent!')
        .describe('The "entrypoint" agent to the swarm, often your "router" or "orchestrator" agent.'),
    initialContext: z.record(z.string(), jsonValueSchema)
        .default({})
        .describe('Context variables for the swarm'),
    name: z.string()
        .optional()
        .describe('A name for the swarm'),
    agents: z.array(z.custom<Agent>((data) => data instanceof Agent))
        .describe('Exhaustive list of agents that may be routed to in the swarm')
})

export type SwarmOptions = z.input<typeof swarmOptionsSchema>
export type ParsedSwarmOptions = z.infer<typeof swarmOptionsSchema>

export const swarmInvocationOptionsSchema = z.object({
    updateLeader: z.custom<Agent>((agent) => agent instanceof Agent, 'Swarm leader must be an agent!')
        .optional()
        .describe('Override the current active agent; basically lets you swap out the stream down-stream'),
    updatedContext: z.record(z.string(), jsonValueSchema)
        .default({})
        .describe('Context variable updates & overrides for the swarm'),
    userMessage: z.string()
        .describe('The user input to generate the output in response to'),
    overrideMessages: z.array(z.custom<SwarmMessage>())
        .optional()
        .describe('The messages & instructions to run the swarm against'),
    maxTurns: z.number()
        .default(100)
        .describe('The maximum number of invocations allowed before sending an unprocessed response'),

})

export type SwarmInvocationOptions = z.input<typeof swarmInvocationOptionsSchema>
export type ParsedSwarmInvocationOptions = z.infer<typeof swarmInvocationOptionsSchema>
