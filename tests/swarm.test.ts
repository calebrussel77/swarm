import {describe, expect, test, beforeEach} from 'bun:test'
import {Swarm} from '../src'
import {openai} from '@ai-sdk/openai'
import {Agent} from '../src/agent'
import z from 'zod'
import {Hive} from '../src/hive'
import {type TextPart, tool, type ToolCallPart} from 'ai'


describe('Swarm Initialization tests', () => {

    test('Create a swarm with an agent should succeed', () => {

        let agent: Agent
        let swarm: Swarm

        expect(() => {
            agent = new Agent({
                name: 'Haiku writer',
                description: 'Always responds in haikus',
                instructions: 'Write a haiku in response to the user\'s request',
            })
        }).not.toThrowError()

        expect(() => {
            swarm = new Swarm({
                defaultModel: openai('gpt-4o-mini'),
                name: 'Test Swarm',
                queen: agent,
                initialContext: {}
            })
        }).not.toThrowError()
    })
})


describe('Simple Swarm', async () => {
    interface SalesContext {
        topic: string | null
        weather: string | null
    }

    const salesAgent: Agent<SalesContext> = new Agent<SalesContext>({
        name: 'Kyle the salesman',
        description: 'Agent to answer sales queries',
        instructions: 'You are a salesman for Salesforce. You answer all sales questions about salesforce to the best of your ability.'
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
                    swarmContext: z.custom<SalesContext>()
                }),
                execute: async ({city, swarmContext}, options) => {
                    console.log(`Executing weather tool.`)
                    return {
                        result: "70 degrees fahrenheit and sunny",
                        context: {
                            topic: 'the weather',
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
                        context: {topic}
                    }
                }
            }
        }

    })

    const hive = new Hive<SalesContext>({
        queen: receptionistAgent,
        defaultModel: openai('gpt-4o-mini'),
        defaultContext: {topic: null, weather: null},
    })

    let swarm: Swarm<SalesContext>

    beforeEach(() => {
        swarm = hive.spawnSwarm({})
    })

    test('Simple question should not trigger handoff', async () => {

        const result = await swarm.generateText({
            content: 'Hi, how are you?'
        })

        expect(result.finishReason).toEqual('stop')
        expect(swarm.activeAgent.name).toEqual(receptionistAgent.name)
        expect(result.messages.filter(message => message.role === 'tool').length).toEqual(0)

    })

    test('Asking for an agent should trigger a handoff', async () => {

        const result = await swarm.generateText({
            messages: [
                {role: 'user', content: 'Hi, how are you doing today?'},
                {role: 'assistant', content: "I'm doing great, how can I help you today? "},
                {role: 'user', content: "I'd like to talk to someone about salesforce AI agents"}
            ]
        })

        expect(result.finishReason).toEqual('stop')
        expect(swarm.activeAgent.name).toEqual(salesAgent.name)

        const toolCalls = result.messages.filter(message => message.role === 'assistant')
            .filter(message => typeof message.content !== 'string')
            .map(message => (message.content as Array<TextPart | ToolCallPart>).flat())
            .flat()
            .filter(part => part.type === 'tool-call')
            .map(part => part.toolName)
        expect(toolCalls).toContain('transfer_to_sales')
    })

    test('Context should be updated by tool calls.', async () => {

        const result = await swarm.generateText({
            content: 'Can I talk to sales about Salesforce AI Agents?',
            onStepFinish: async (stepFinish, context) => {
                expect(context).toBeDefined()
            }
        })
        expect(result.activeAgent.name).toEqual(salesAgent.name)
        expect(swarm.getContext().topic).toBeDefined()
    })

    test('Updating context should result in updated context in subsequent runs', async () => {
        let result = await swarm.generateText({
            content: 'Can I talk to sales about Salesforce AI Agents?',
            onStepFinish: async (stepFinish, context) => {
                expect(context).toBeDefined()
            }
        })

        expect(result.context.topic).toBeDefined()
        swarm.updateContext({
            topic: 'what does salesforce do?'
        })

        result = await swarm.generateText({
            content: 'What does salesforce actually do',
            onStepFinish: async (stepFinish, context) => {
                expect(context.topic).toEqual('what does salesforce do?')
            }
        })
        expect(result.context.topic).toEqual('what does salesforce do?')

    })


    test('Tools should receive context not generated by tools', async () => {
        const result = await swarm.generateText({
            content: 'What is the weather in New York??'
        })
        expect(result.activeAgent.name).toEqual(receptionistAgent.name)
        const toolCalls = result.messages.filter(message => message.role === 'assistant')
            .filter(message => typeof message.content !== 'string')
            .map(message => (message.content as Array<TextPart | ToolCallPart>).flat())
            .flat()
            .filter(part => part.type === 'tool-call')
            .map(part => part.toolName)

        expect(result.context.topic).toEqual('the weather') // weather tool manually sets this
        expect(result.context.weather).toBeDefined()
        expect(toolCalls).toContain('get_current_weather')
    })
})
