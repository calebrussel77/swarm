import {Agent, Swarm} from '../src'
import z from 'zod'

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

const swarm = new Swarm({
    initialContext: {
        topic: "",
        weather: "",
    },
    queen: receptionistAgent
})

const result = swarm.streamText({content: "What is the weather outside in dallas?"})
for await (let textChunk of result.textStream) {
    process.stdout.write(textChunk)
}
process.stdout.write('\n')