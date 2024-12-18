import z from 'zod'
import type {JSONValue, LanguageModelV1} from 'ai'
import {
    type SwarmInvocationOptions,
    swarmInvocationOptionsSchema,
    type SwarmOptions,
    swarmOptionsSchema
} from './schemas/swarm.schemas.ts'
import type {Agent} from './agent.ts'
import {deepCopy, DefaultRecord} from './utils.ts'
import type {SwarmMessage} from './types.ts'
import {createLogger} from './logger.ts'

const logger = createLogger(__filename)

/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm {

    private defaultLanguageModel: LanguageModelV1
    private activeAgent: Agent
    private messages: Array<SwarmMessage>
    private context: Record<string, JSONValue>
    private readonly name?: string

    constructor(options: SwarmOptions) {

        const swarmOptions = swarmOptionsSchema.parse(options)

        this.defaultLanguageModel = swarmOptions.defaultLanguageModel
        this.activeAgent = swarmOptions.leader
        this.messages = swarmOptions.messages
        this.context = swarmOptions.initialContext
        this.name = swarmOptions.name

        logger.info(`Initiated swam ${swarmOptions.name}`)
    }

    /**
     * Use the swarm to generate text / tool calls
     */
    public async generateText(options: SwarmInvocationOptions) {

        const invocationOptions = swarmInvocationOptionsSchema.parse(options)
        logger.info(`Triggered swarm for user input: "${options.userMessage}"`)

        // handle any swarm updates & overrides based on the user input
        this.handleUpdatesAndOverrides(options)

        for (let i = 0; i < invocationOptions.maxTurns; i++) {


        }


    }

    /**
     * Handle generating text with the agent
     * @param options
     * @private
     */
    private async handleGeneratingText(options: SwarmInvocationOptions) {
        const agentInstructions = this.activeAgent.getInstructions(this.context)
        const messages: Array<SwarmMessage> = [
            {role: 'system', content: agentInstructions},
            ...this.messages
        ]
        logger.debug(`Creating chat completion for conversation:`, messages)


    }
    /**
     * Handle updating and overriding models configurations based on invocation options
     * @param invocationOptions
     * @private
     */
    private handleUpdatesAndOverrides(invocationOptions: SwarmInvocationOptions) {
        if (invocationOptions.updateLeader) {
            this.activeAgent = invocationOptions.updateLeader
            logger.warn(`Overriding swarm ${this.name ? "'" + this.name + "' " : ''}leader from ${this.activeAgent.name} to ${this.activeAgent.name}`)
        }

        this.context = {
            ...this.context,
            ...invocationOptions.updatedContext
        }

        if (invocationOptions.overrideMessages && invocationOptions.overrideMessages.length) {
            this.messages = invocationOptions.overrideMessages
            logger.warn(`Overriding swarm ${this.name ? "'" + this.name + "' " : ''} messages...`)
        }

    }

}