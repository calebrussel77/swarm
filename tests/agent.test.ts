import {describe, test, expect} from 'bun:test'
import Agent from '../src/agent'
import {Swarm} from '../src'
import {openai} from '@ai-sdk/openai'
import {tool} from 'ai'
import z from 'zod'
import {jsonValueSchema} from '../src/schemas/common.schemas'

describe('Agent Initialization tests', () => {

    test('Create a simple agent', () => {

        expect(() => new Agent({
            name: 'Example agent',
            description: 'A simple agent that answers user queries',
            instructions: 'You are a helpful assistant',
        })).not.toThrowError()
    })
})

describe('Agent text generation', async () => {
    test('Generate text', async () => {

        const salesAgent = new Agent({
            name: 'Kyle the salesman',
            description: 'Agent to answer sales queries',
            instructions: 'You answer all sales questions about salesforce to the best of your ability.'
        })

        // TODO allow passing template type into swarm and agent for swarm context
        const routerAgent = new Agent({
            name: 'Example agent',
            description: 'A simple agent that answers user queries',
            instructions: 'You help users talk to the person that they want to talk to by routing them appropriately.',
            tools: {
                get_current_weather: {
                    type: 'function',
                    description: 'Get the weather in a given city',
                    parameters: z.object({
                        city: z.string().describe('The city to get the weather for.'),
                        swarmContext: z.record(z.string(), jsonValueSchema)
                    }),
                    execute: async ({city, swarmContext}, options) => {
                        console.log(`Got weather for city ${city} with context`, swarmContext)
                        return "70 degrees fahrenheit and sunny"
                    }
                },
            }

        })
        const swarm = new Swarm({
            name: 'Example swarm',
            leader: routerAgent,
            defaultLanguageModel: openai('gpt-4o-mini'),
            agents: [routerAgent, salesAgent]
        })

        const result = await swarm.generateText({
            userMessage: 'Can I talk to sales?'
        })

    })
})