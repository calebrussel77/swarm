import z from 'zod'
import {
    type CoreTool,
    type JSONValue,
    type LanguageModelV1,
    type ToolExecutionOptions,
    tool,
    generateText
} from 'ai'
import {
    type SwarmInvocationOptions,
    swarmInvocationOptionsSchema,
    type SwarmOptions,
    swarmOptionsSchema
} from './schemas/swarm.schemas'
import type {Agent} from './agent'
import type {SwarmMessage} from './types'
import {createLogger} from './logger'
import {agentInvocationSchema} from './schemas/agent.schemas'

const logger = createLogger(__filename)

const SWARM_CONTEXT_PROPERTY_NAME = 'swarmContext'

/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm {

    private readonly defaultLanguageModel: LanguageModelV1
    private activeAgent: Agent
    private messages: Array<SwarmMessage>
    private context: Record<string, JSONValue>
    private readonly name?: string
    private agents: Array<Agent>

    constructor(options: SwarmOptions) {

        const swarmOptions = swarmOptionsSchema.parse(options)

        this.defaultLanguageModel = swarmOptions.defaultLanguageModel
        this.activeAgent = swarmOptions.leader
        this.messages = swarmOptions.messages
        this.context = swarmOptions.initialContext
        this.name = swarmOptions.name
        this.agents = swarmOptions.agents

        logger.info(`Initiated swam ${swarmOptions.name}`)
    }

    /**
     * Use the swarm to generate text / tool calls
     */
    public async generateText(options: SwarmInvocationOptions) {

        const invocation = swarmInvocationOptionsSchema.parse(options)
        logger.info(`Triggered swarm for user input: "${options.userMessage}"`)

        // handle any swarm updates & overrides based on the user input
        this.handleUpdatesAndOverrides(options)

        for (let i = 0; i < invocation.maxTurns; i++) {
            // We need to re-build instructions evert time since context may change!
            const agentInstructions = this.activeAgent.getInstructions(this.context)
            // Add the agent's system prompt to the front of the messages
            const messages: Array<SwarmMessage> = [
                {role: 'system', content: agentInstructions},
                {role: 'user', content: invocation.userMessage},
                ...this.messages
            ]
            logger.debug(`Creating chat completion for conversation:`, messages)

            // Wrap tools so the LLM can't see the magic `swarmContext` tool parameters
            const toolsForModel = this.wrapAgentToolsToHideContext(this.activeAgent.tools)

            // Do execution
            const result = await generateText({
                model: this.activeAgent.config.languageModel || this.defaultLanguageModel,
                messages: messages,
                tools: toolsForModel,
                // @ts-expect-error - we are doing zod validation so this should be fine
                toolChoice: this.activeAgent.config.toolChoice,
                maxTokens: this.activeAgent.config.maxTokens,
                temperature: this.activeAgent.config.temperature
            })
            const {text, toolResults, toolCalls, response, steps } = result
            logger.debug(`text:`, text)
            logger.debug(`toolResults: `, toolResults)
            logger.debug(`tool calls`, toolCalls)
            logger.debug(`response.messages:`, response.messages)
            //logger.debug(`steps:`, steps)

            // Check if should transfer
            for (const result of toolResults) {
                // @ts-expect-error - it works!
                const toolCallReturnValue = result.result
                const {
                    success: commandRequested,
                    data: commandInfo
                } = agentInvocationSchema.safeParse(toolCallReturnValue)
                if (commandRequested ) {
                    const agentToTransferTo = this.agents.find(agent => agent.uuid === commandInfo.uuid)
                    if (!agentToTransferTo) {
                        // NOTE THIS SHOULD NEVER HAPPEN
                        logger.error(`Requested to transfer to agent ${commandInfo.uuid} but no such agent was found:`, this.agents)
                    }
                }
            }

            // NOTE TODO REMOVE THIS
            break;

        }

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

    /**
     * wrap the agent's tools to hide the swarmContext property that they can request to get access to the swarm's context;
     * so that the LLM doesn't see it and try to generate it. this requires modifying the JSON schema, and wrapping the executor.
     * @param tools
     * @private
     */
    private wrapAgentToolsToHideContext(tools: Record<string, CoreTool>): Record<string, CoreTool> {
        const toolsForModel: Record<string, CoreTool> = {}
        for (const toolName in this.activeAgent.tools) {
            const agentTool = this.activeAgent.tools[toolName]

            // handle if the tool requests swarm context - we don't want the LLM generating this, so we strip it
            // from the tool call
            if (SWARM_CONTEXT_PROPERTY_NAME in agentTool.parameters.shape) {
                logger.debug(`Removing swarm context from tool ${toolName}`)

                // reconfigure the parameters to drop the context property
                const rewrittenParameters = agentTool.parameters.omit({
                    [SWARM_CONTEXT_PROPERTY_NAME]: true
                })

                // If the tool has an executor, wrap it with a function that receives just the LLM args, then retrieves
                // the swarm context before executing the agent tools with it.
                if (typeof agentTool.execute !== 'undefined') {
                    logger.debug(`Wrapping tool ${toolName} with an executor`)
                    const rewrittenExecutor = async (
                        args: z.infer<typeof rewrittenParameters>,
                        options: ToolExecutionOptions
                    ) => {
                        const swarmContext: Record<string, JSONValue> = this.getContext()
                        return await agentTool.execute!(
                            {...args, [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext},
                            options
                        )
                    }

                    toolsForModel[toolName] = tool({
                        // @ts-expect-error it's there I promise!
                        description: agentTool.description,
                        parameters: rewrittenParameters,
                        execute: rewrittenExecutor
                    })
                }
                // If there isn't an executor, just skip it.
                else {
                    logger.debug(`Pushing tool ${toolName} without an executor`)
                    toolsForModel[toolName] = tool({
                        // @ts-expect-error - it works! we checked!
                        description: agentTool.description,
                        parameters: rewrittenParameters
                    })
                }

            }
            // Schema doesn't request context, so just ignore
            else {
                toolsForModel[toolName] = agentTool
            }


        }
        return toolsForModel
    }

    public getContext() {
        return this.context
    }

}