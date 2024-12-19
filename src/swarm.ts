import z from 'zod'
import type {
    CoreTool,
    JSONValue,
    LanguageModel,
    ToolExecutionOptions,
    CoreAssistantMessage,
    CoreSystemMessage,
    CoreUserMessage,
    CoreToolMessage, CoreMessage, UserContent, GenerateTextResult
} from 'ai'
import {tool, generateText} from 'ai'
import {Agent, type AgentTool} from './agent'
import {createLogger} from './logger'
import type {JSONSerializableObject} from './utils'

const logger = createLogger(__filename)

const SWARM_CONTEXT_PROPERTY_NAME = 'swarmContext'

export type SwarmMessage = (CoreAssistantMessage & { sender?: string }) |
    CoreUserMessage |
    CoreToolMessage |
    CoreSystemMessage

export type SwarmOptions<SWARM_CONTEXT extends JSONSerializableObject> = {
    defaultModel: LanguageModel
    queen: Agent<SWARM_CONTEXT>
    initialContext: SWARM_CONTEXT
    messages?: Array<SwarmMessage>
    name?: string
    maxTurns?: number
    returnToQueen?: boolean // should control of the swarm be returned to the queen post-completion?
}

/**
 * Invoke the swarm to handle a user message
 */
export type SwarmInvocationOptions<SWARM_CONTEXT extends JSONSerializableObject> = {
    content: UserContent,
    contextUpdate?: Partial<SWARM_CONTEXT>
    setAgent?: Agent<SWARM_CONTEXT>
    maxTurns?: number
    returnToQueen?: boolean // should control of the swarm be returned to the queen post-completion?
}


/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm<SWARM_CONTEXT extends JSONSerializableObject = JSONSerializableObject> {

    readonly defaultModeL: LanguageModel
    readonly name?: string
    private context: SWARM_CONTEXT
    private messages: Array<SwarmMessage>
    private queen: Agent<SWARM_CONTEXT>
    private activeAgent: Agent<SWARM_CONTEXT>
    private readonly maxTurns?: number
    private returnToQueen: boolean

    constructor(options: SwarmOptions<SWARM_CONTEXT>) {
        this.context = options.initialContext || {}
        this.defaultModeL = options.defaultModel
        this.queen = options.queen
        this.activeAgent = options.queen
        this.messages = options.messages || []
        this.name = options.name
        this.maxTurns = options.maxTurns
        this.returnToQueen = !!options.returnToQueen
    }

    /**
     * Use the swarm to generate text / tool calls
     */
    public async generateText(options: SwarmInvocationOptions<SWARM_CONTEXT>) {

        logger.info(`Triggered swarm for user input: "${options.content}"`)
        // handle any swarm updates & overrides based on the user input
        this.handleUpdatesAndOverrides(options)

        const maxTurns = options.maxTurns || this.maxTurns
        const messages: Array<CoreMessage> = [
            {role: 'system', content: this.activeAgent.getInstructions(this.context)},
            ...this.messages,
            {role: 'user', content: options.content}
        ]
        const tools = this.wrapTools(this.activeAgent.tools)

        // Can generate prompt instead too
        let lastResult: GenerateTextResult<any, any>
        const responseMessages: Array<CoreMessage> = []

        // TODO reset the current agent to the queen, if requested.
    }

    /**
     * Return a read-only version of the context
     */
    public getContext() {
        return this.context as Readonly<SWARM_CONTEXT>
    }

    /**
     * Update context, and receive a readonly version of it.
     * @param update
     */
    public updateContext(update: Partial<SWARM_CONTEXT>) {
        this.context = {
            ...this.context,
            ...update
        }
        return this.context as Readonly<SWARM_CONTEXT>
    }

    /**
     * Handle updating and overriding models configurations based on invocation options
     * @param invocationOptions
     * @private
     */
    private handleUpdatesAndOverrides(invocationOptions: SwarmInvocationOptions<SWARM_CONTEXT>) {
        // Handle changing the active agent
        if (invocationOptions.setAgent) {
            logger.warn(`Overriding swarm ${this.name ? "'" + this.name + "' " : ''}leader from ${this.activeAgent.name} to ${invocationOptions.setAgent.name}`)
            this.activeAgent = invocationOptions.setAgent
        }

        // handle
        this.context = {
            ...this.context,
            ...invocationOptions.contextUpdate
        }
        logger.debug(`Updated`)
    }

    /**
     * wrap the agent's tools to hide the swarmContext property that they can request to get access to the swarm's context;
     * so that the LLM doesn't see it and try to generate it. this requires modifying the JSON schema, and wrapping the executor.
     * @param tools
     * @private
     */
    private wrapTools(tools: Record<string, AgentTool<SWARM_CONTEXT>> | undefined): Record<string, CoreTool> | undefined {

        if (!tools) return undefined

        // Map each tool into a CoreTool
        return Object.fromEntries(Object.entries(tools).map((
                [toolName, agentTool]: [string, AgentTool<SWARM_CONTEXT>]
            ): [string, CoreTool] => {


                let parameters: AgentTool<SWARM_CONTEXT>['parameters'] = agentTool.parameters
                let executor: CoreTool['execute'] = undefined;

                // If the tool requests the swarm's context, we don't want the LLM to generate it,
                //  so strip it from the tool call parameters and wrap the executor
                if (SWARM_CONTEXT_PROPERTY_NAME in agentTool.parameters.shape) {
                    logger.debug(`Removing ${SWARM_CONTEXT_PROPERTY_NAME} from parameters for tool ${toolName}`)

                    // Set the parameters for the tool so they omit the context; so that the LLM doesn't generate it
                    parameters = agentTool.parameters.omit({
                        [SWARM_CONTEXT_PROPERTY_NAME]: true
                    })

                    // if there's an executor, wrap it with an executor that only receives the LLM-generated arguments
                    //  (i.e. no context) and that then GETS the context of the swarm, and passed it along with the
                    //  LLM generated-params (so both LLM params and swarm context) to the original executor.
                    if (agentTool.execute) {
                        executor = async (
                            args: z.infer<typeof parameters>,
                            options: ToolExecutionOptions
                        ) => {
                            const swarmContext: Record<string, JSONValue> = this.getContext()

                            // Execute the agent tool with the arguments and the parameters
                            return agentTool.execute!(
                                {
                                    ...args,
                                    [SWARM_CONTEXT_PROPERTY_NAME]: swarmContext
                                },
                                options
                            )
                        }

                    }
                    logger.debug(`Wrapped tool ${toolName}. previous args shape: `, Object.keys(agentTool.parameters.shape))
                    logger.debug(`New args shape:`, Object.keys(parameters.shape))

                }

                // If the tool type is handover, ensure there's no executor so that generation stops and we can
                // stop the agent
                if (agentTool.type === 'handover') {
                    executor = undefined
                }

                // NOTE this looks more complicated (you'd think you could just pass an undefined executor) but you
                // cannot, so it has to be done this way.
                const wrappedTool = executor
                    ? tool({
                        type: 'function',
                        description: agentTool.description,
                        parameters: parameters,
                        execute: executor
                    })
                    : tool({
                        type: 'function',
                        description: agentTool.description,
                        parameters: parameters,
                    })

                return [toolName, wrappedTool]
            })
        )

    }

}