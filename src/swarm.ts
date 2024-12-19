import z from 'zod'
import type {
    CoreTool,
    JSONValue,
    LanguageModel,
    ToolExecutionOptions,
    CoreAssistantMessage,
    CoreSystemMessage,
    CoreUserMessage,
    CoreToolMessage, CoreMessage, UserContent, GenerateTextResult, CoreToolChoice, StepResult, ToolResultPart
} from 'ai'
import {tool, generateText} from 'ai'
import {Agent, type AgentHandoverTool, type AgentTool} from './agent'
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
    onStepFinish?: (event: StepResult<any>) => Promise<void> | void;

}


/**
 * The swarm is the callable that can generate text, generate objects, or stream text.
 */
export class Swarm<SWARM_CONTEXT extends JSONSerializableObject = JSONSerializableObject> {

    readonly defaultModel: LanguageModel
    readonly name?: string
    private context: SWARM_CONTEXT
    private messages: Array<SwarmMessage>
    private queen: Agent<SWARM_CONTEXT>
    private activeAgent: Agent<SWARM_CONTEXT>
    private readonly maxTurns: number
    private returnToQueen: boolean

    constructor(options: SwarmOptions<SWARM_CONTEXT>) {
        this.context = options.initialContext || {}
        this.defaultModel = options.defaultModel
        this.queen = options.queen
        this.activeAgent = options.queen
        this.messages = options.messages || []
        this.name = options.name
        this.maxTurns = options.maxTurns || 100
        this.returnToQueen = !!options.returnToQueen
    }

    /**
     * Use the swarm to generate text / tool calls
     */
    public async generateText(options: SwarmInvocationOptions<SWARM_CONTEXT>) {

        logger.info(`Triggered swarm for user input: "${options.content}"`)
        // handle any swarm updates & overrides based on the user input
        this.handleUpdatesAndOverrides(options)

        const messages: Array<CoreMessage> = [
            ...this.messages,
            {role: 'user', content: options.content}
        ]

        // Can generate prompt instead too
        let lastResult: GenerateTextResult<any, any>
        const responseMessages: Array<SwarmMessage> = []

        // Get the maximum number of turns which is the **minimum** number of turns
        const maxTotalSteps = options.maxTurns ?? this.maxTurns
        let stepsLeft = maxTotalSteps
        do {
            const maxStepsForThisAgent = this.activeAgent.config.maxTurns ?? maxTotalSteps

            const wrappedTools = this.wrapTools(this.activeAgent.tools),
                lastResult = await generateText({
                    model: this.activeAgent.config.model || this.defaultModel,
                    system: this.activeAgent.getInstructions(this.context),
                    tools: wrappedTools,
                    maxSteps: maxStepsForThisAgent,
                    toolChoice: this.activeAgent.config.toolChoice,
                    onStepFinish: options.onStepFinish,
                    messages: [
                        ...this.messages,
                        ...responseMessages
                    ]
                })

            const stepsTakenThisRound = lastResult.response.messages.filter(
                message => message.role === 'assistant'
            ).length

            // On completion, add messages with name of current assistant
            responseMessages.push(...lastResult.response.messages.map(message => ({
                ...message,
                sender: this.activeAgent.name
            })))

            // if there is an agent handover or an agent reaches max number of turns
            if (lastResult.finishReason !== 'tool-calls') {
                // we're done, the model generated text
                break
            }

            const {toolCalls, toolResults} = lastResult
            const toolResultIds = toolResults.map(result => result.toolCallId)
            const unhandledToolCalls = toolCalls.filter(
                toolCall => !toolResultIds.includes(toolCall.toolCallId)
            )

            // Process handover calls
            const handoverCalls = unhandledToolCalls.filter(
                toolCall => this.activeAgent.tools?.[toolCall.toolName].type === 'handover'
            )

            // Take the first handover call
            let handoverToolResult: ToolResultPart | undefined;

            if (handoverCalls.length > 0) {
                const handoverTool = this.activeAgent.tools?.[
                    handoverCalls[0].toolName
                ]! as AgentHandoverTool<SWARM_CONTEXT, any>

                logger.debug(`Received handover tool call:`, handoverCalls[0].toolName)
                logger.debug(`received args: `, handoverCalls[0].args)

                // execute the tool call which returns the agent, and a context update
                const result = await handoverTool.execute({
                    ...handoverCalls[0].args,
                    ...this.context
                }, {})

                logger.info(`Agent ${this.activeAgent.name} handing over to ${result.agent.name} with context update:`, result.context)

                this.activeAgent = result.agent
                if (result.context) this.context = {
                    ...this.context,
                    ...result.context
                }
            }


            // TODO: Check for tool call - if agent transfer, handle transfer

            // TODO: If not agent transfer - we are either out of MAX steps, or steps for agent.
            // If out of MAX steps, break; if out of steps for Agent; return to router and resume


            // Otherwise if a tool was called and it's not an agent transfer, that means the agent reached max number
            // of turns and we need to return control to the queen and then decrement maxTurns and keep looping
        }
        while (stepsLeft < maxTotalSteps)

        // TODO reset the current agent to the queen, if requested.

        // TODO update the history
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
    private wrapTools(
        tools: Record<string, AgentTool<SWARM_CONTEXT>> | undefined
    ): Record<string, CoreTool> | undefined {

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

function minimum(a: number, b: number) {
    return a < b
        ? a
        : b
}