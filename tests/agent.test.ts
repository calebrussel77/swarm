import {describe, test, expect} from 'bun:test'
import Agent from '../src/agent'
import {Swarm} from '../src'
import {openai} from '@ai-sdk/openai'
import {tool} from 'ai'
import z from 'zod'

import {type JSONSerializableObject, jsonValueSchema} from '../src/utils'
import logger from '../src/logger'

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

        interface SalesContext {
            topic: string | null
        }
        const salesAgent = new Agent<SalesContext>({
            name: 'Kyle the salesman',
            description: 'Agent to answer sales queries',
            instructions: 'You are a salesman for Salesforce. You answer all sales questions about salesforce to the best of your ability.'
        })

        const receptionist = new Agent<SalesContext>({
            name: 'Receptionist',
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
                transfer_to_sales: {
                    type: 'handover',
                    description: 'Transfer the conversation to a sales agent who can answer questions about sales',
                    parameters: z.object({
                        topic: z.string().describe('The topic of the sales conversation')
                    }),
                    execute: async ({topic}) => {
                        return {
                            agent: salesAgent,
                        }
                    }
                }
            }

        })

        const swarm = new Swarm<SalesContext>({
            name: 'Example swarm',
            queen: receptionist,
            defaultModel: openai('gpt-4o-mini'),
            initialContext: {topic: null},
        })

        const result = await swarm.generateText({
            content: 'Can I talk to sales about salesforce AI Agents?',
            onStepFinish: ({text, stepType, toolCalls, toolResults}, context) => {
            }
        })

        expect(result.activeAgent.name).toEqual(salesAgent.name)

        logger.debug(`Generation result:`, result)

    })
})