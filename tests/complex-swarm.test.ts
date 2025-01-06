import {Agent, Hive} from '../src'
import z from 'zod'
import * as readline from 'readline'

interface Context {
    product: string | null
    managerInstructions: string | null
}

const cardInformationSchema = z.object({
    cardNumber: z.string().min(15).max(16).describe('The number of the credit card to validate. Must be exactly 15 or 16 numerical digits'),
    cardExpirationMonth: z.number().min(1).max(12).describe('The month of the year, described as a number where January is 1 and December is 12'),
    cardExpirationYear: z.number().min(2024).max(2036).describe('The year that the credit card expires in'),
    cardCvvCode: z.number().min(100).max(9999).describe('The 3- or 4-digit numerical CVV / security code for the card'),
    cardholderFullName: z.string().describe('The cardholder\'s full name')
})

const bankAccountInformationSchema = z.object({
    accountNumber: z.string().describe('The bank account number provided by the user; comes in varying lengths and formats'),
    routingNumber: z.string().describe('The routing number provided by the user, comes in varying formats and lengths'),
    accountHolder: z.string().describe('The full name of the individual or business that owns the account')
})

const productSchema = z.enum([
    'IBM Watson API', 'IBM Transcription API'
]).describe('The product that the charge is for. pricing will be calculated automatically.')

const authenticationCodeSchema = z.string().describe('The 6-digit authentication code that the user received')

const implementationAgent = new Agent<Context>({
    name: 'Implementation agent',
    description: 'Helps users implement purchased solutions',
    instructions: "You are an agent that is helping a user to implement the {{product}} solution. Answer their " +
        "questions as helpfully as you can!",
    tools: {},
})

const paymentCollector = new Agent<Context>({
    name: 'Payment Collector Agent',
    description: 'Collects payment information to charge the user for the {{product}}',
    instructions: 'You are a helpful payment processor whose job it is to collect payment information from a user ' +
        'for the product that they are purchasing. It is your job to help the user decide on a payment method, ' +
        '(You can accept either bank account information or credit card), to collect their payment information, ' +
        'to validate the information, and then you charge the payment method, before transferring ' +
        'the person to the onboarding team.\n\nUse the tools that are available to you when appropriate, but do' +
        'not assume any information. Make sure to ask for everything you need before calling a tool. If payment ' +
        'information fails to validate or charge, you need to help the user to provide a different payment method.' +
        'If a user gives you invalid information (e.g. a date in the past, or an invalid credit card number) make sure' +
        'to ask them for correct information. Sometimes, when you charge a payment method, you will need to get a 6-digit' +
        'confirmation code from the user that you have to submit in order to authenticate the transaction and complete it.',
    tools: {
        validate_bank_account_information: {
            type: 'function',
            description: 'Call this tool to validate bank account information before executing a charge, to avoid payment fraud.',
            parameters: bankAccountInformationSchema,
            execute: async (information) => {
                console.log(`validate bank account information:`, information)
                const num = Math.random()
                return {
                    result: num >= 5 ? 'This account is valid' : 'This account is not valid',
                }
            }
        },
        validate_card_information: {
            type: 'function',
            description: 'Call this tool to validate credit card information before executing a charge, to prevent chargebacks',
            parameters: cardInformationSchema,
            execute: async (cardInfo) => {
                console.log(`validating card information:`, cardInfo)
                const num = Math.random()
                return {
                    result: num >= 0.5 ? 'This card is valid' : 'This card is not valid'
                }
            }
        },
        charge_credit_card: {
            type: 'function',
            description: 'Call this tool to execute a charge for a credit card.',
            parameters: cardInformationSchema.merge(z.object({product: productSchema})),
            execute: async (cardInfo) => {
                console.log(`charging card:`, cardInfo)
                return {
                    result: 'Transaction pending. Please submit the 6-digit authentication code that has been sent ' +
                        'to the user in order to authenticate the transaction'
                }
            }
        },
        charge_bank_account: {
            type: 'function',
            description: 'Call this tool to execut2e a charge for a bank account',
            parameters: bankAccountInformationSchema.merge(z.object({product: productSchema})),
            execute: async (bankInfo) => {
                console.log(`charging bank account:`, bankInfo)
                return {
                    result: 'Transaction completed!'
                }
            }
        },
        submit_authentication_code: {
            type: 'function',
            description: 'Call this tool to submit a 6-digit authentication code to complete a transaction',
            parameters: z.object({
                code: authenticationCodeSchema
            }),
            execute: async (info) => {
                console.log(`submitting auth code:`, info)
                return {
                    result: 'Transaction completed!'
                }
            }
        },
        transfer_to_implementation_agent: {
            type: 'handover',
            description: 'Call this tool to transfer the user to an agent to help them implement a solution once they ' +
                'have paid for it\.',
            parameters: z.object({
                product: productSchema
            }),
            execute: async ({product}) => {
                return {
                    agent: implementationAgent,
                }
            }
        }
    },
    toolChoice: 'auto'
})

const managerAgent = new Agent<Context>({
    name: 'Manager Agent',
    description: 'A manager that can answer questions.',
    instructions: 'You talk to people who have been speaking to an IBM sales agent, but who wanted to talk to' +
        'the manager. answer questions as helpfully as you can. Transfer the person back to the sales agent when' +
        'they are ready to talk to them again.',
    tools: {}
})

const aiSalesAgent = new Agent<Context>({
    name: 'AI Sales Agent',
    description: 'Sells IBM AI solutions',
    instructions: 'You are a sales agent on the phone whose job it is to answer questions about IBM\'s Watson platform. ' +
        'You are responsible for selling two solutions: IBM Watson API, and the IBM transcription API.' +
        'Answer questions and pitch the user to try and convince them to purchase a Watson API Key. Be polite, ' +
        'but persistent. Once a user is ready to buy a solution, transfer the call to the payment processor agent.' +
        '{% if managerInstructions %}Follow the following instructions from your manager: {{managerInstructions }} {% endif %}',
    tools: {
        transfer_to_payments: {
            type: 'handover',
            description: 'Call this tool to transfer to the payment collector agent so that they can process payment',
            parameters: z.object({
                product: productSchema,
                swarmContext: z.custom<Context>()
            }),
            execute: async ({product, swarmContext}) => {
                return {
                    agent: paymentCollector,
                    context: {product}
                }
            }
        },
        transfer_to_manager: {
            type: 'handover',
            description: 'Call this tool to transfer the call to the manager when the person on the call asks to' +
                'speak to the manager OR gets frustrated',
            parameters: z.object({}),
            execute: async () => ({agent: managerAgent})
        }
    }
})

const receptionistAgent = new Agent({
    name: 'Receptionist Agent',
    description: 'Answers calls and routes them appropriately',
    instructions: 'You are a receptionist agent whose job it is to greet people and route calls appropriately. ' +
        'You can transfer calls to sales, to a manager, or to an implementation specialist.',
    tools: {
        transfer_to_sales: {
            type: 'handover',
            description: 'Call this tool to transfer the call to a sales agent who can answer questions about IBM ' +
                'watson API and IBM Transcription API',
            parameters: z.object({}),
            execute: async () => ({agent: aiSalesAgent})
        },
        transfer_to_manager: {
            type: 'handover',
            description: 'Call this tool to transfer the call to a manager if the person asks to talk to them',
            parameters: z.object({}),
            execute: async () => ({agent: managerAgent})
        },
        transfer_to_implementation: {
            type: 'handover',
            description: 'Transfer this call to an implementation agent who can help implement Watson and transcription solutions',
            parameters: z.object({
                product: productSchema,
                swarmContext: z.custom<Context>()
            }),
            execute: async ({product, swarmContext}) => ({agent: implementationAgent, context: product})
        }
    }
})


// Handle the "circular" case
managerAgent.tools!['transfer_to_sales'] = {
    type: 'handover',
    description: 'Call this tool to transfer back to the sales agent when the user is ready to talk to them again. ',
    parameters: z.object({
        instructions: z.string().describe("Instructions for the sales agent based on your conversation, e.g. 'be more polite'"),
        swarmContext: z.custom<Context>()
    }),
    execute: async ({instructions, swarmContext}) => ({
        agent: aiSalesAgent,
        context: {managerInstructions: instructions}
    })
}

const transferToReceptionist = {
    type: 'handover',
    description: 'Call this tool to transfer the call to the receptionist',
    parameters: z.object({}),
    execute: async () => ({agent: receptionistAgent})
} as const
managerAgent.tools!['transfer_to_receptionist'] = transferToReceptionist
paymentCollector.tools!['transfer_to_receptionist'] = transferToReceptionist

implementationAgent.tools!['']

const hangupTool = {
    type: 'function',
    description: 'Call this tool to hangup the conversation',
    parameters: z.object({}),
    execute: async () => {
        console.log(`Hanging up!`)
        process.exit(0)

    }
} as const
managerAgent.tools!['hang_up'] = hangupTool
receptionistAgent.tools!['hang_up'] = hangupTool
implementationAgent.tools!['hang_up'] = hangupTool

const hive = new Hive({
    queen: receptionistAgent,
})

const swarm = hive.spawnSwarm({
    defaultContext: {
        product: null,
        managerInstructions: null
    }
})

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

async function main() {

    try {
        while (true) {
            const userInput: string = await new Promise((resolve) => {
                rl.question(`${swarm.activeAgent.name} >>> `, resolve)
            })
            const result = swarm.streamText({
                content: userInput,
                onStepFinish: (event) => {
                    console.log(`\n\nLLM Steps:\n`, event.response.messages)
                }
            });
            for await (const textChunk of result.textStream) {
                process.stdout.write(textChunk)
            }
            await result.text
            process.stdout.write('\n')
        }
    }
    catch (err: any) {
        console.error(err)
        const messages = swarm.getMessages()
        messages.forEach((message) => console.log(message))
    }

}

main().then(() => {console.log(`done`); process.exit(0)})
    .catch((err) => {console.error(err); process.exit(1)})