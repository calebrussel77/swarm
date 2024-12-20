import {type CoreTool, type CoreToolChoice, type LanguageModel, type LanguageModelV1, tool} from 'ai'
import nunjucks from 'nunjucks'
import z from 'zod'
import {randomUUID} from 'node:crypto'
import {type JSONSerializableObject, jsonValueSchema} from './utils'

/**
 * Pulled from vercel AI SDK; useful type defs
 */

/**
 * Type for an agent FUNCTION tool, distinct from a HANDOVER tools
 */
export type AgentFunctionTool<
    SWARM_CONTEXT extends object = JSONSerializableObject,
    TOOL_PARAMETERS extends z.ZodType<any> = z.AnyZodObject,
    FUNCTION_RESULT = any
> = {
    type?: 'function' | undefined,
    description?: string
    parameters: TOOL_PARAMETERS,
    execute: (
        args: z.infer<TOOL_PARAMETERS> & SWARM_CONTEXT,
        options: {
            abortSignal?: AbortSignal,
        },
    ) => Promise<{
        context?: Partial<SWARM_CONTEXT>
        result: FUNCTION_RESULT
    }>
}

/**
 * Type for an agent HANDOVER tool -- the handover tool to trigger an agent; and optionally update the context
 * IF the handover tool has parameters
 */
export type AgentHandoverTool<
    SWARM_CONTEXT extends object = JSONSerializableObject,
    TOOL_PARAMETERS extends z.ZodType<any> = z.AnyZodObject
> = {
    type: 'handover',
    description?: string,
    parameters: TOOL_PARAMETERS,
    execute: (
        args: z.infer<TOOL_PARAMETERS> & SWARM_CONTEXT,
        options: {
            abortSignal?: AbortSignal,
        }
    ) => Promise<{
        agent: Agent<SWARM_CONTEXT>,
        context?: Partial<SWARM_CONTEXT>
    }>

}

export type AgentTool<SWARM_CONTEXT extends object = JSONSerializableObject> =
    AgentFunctionTool<SWARM_CONTEXT, any, any> |
    AgentHandoverTool<SWARM_CONTEXT, any>


/**
 * Agent options
 */
export type AgentOptions<SWARM_CONTEXT extends object = JSONSerializableObject> = {
    name: string
    description: string
    model?: LanguageModel
    instructions: string | ((c: SWARM_CONTEXT) => string)
    tools?: Record<string, AgentTool<SWARM_CONTEXT>>
    toolChoice?: CoreToolChoice<any>
    maxTokens?: number
    temperature?: number
    maxTurns?: number
}


/**
 * The agent class; sensitive to the shape of the swarm's context
 */
export class Agent<SWARM_CONTEXT extends object = JSONSerializableObject> {

    public config: Omit<AgentOptions<SWARM_CONTEXT>, 'name' | 'description' | 'tools'>
    public name: string
    public description: string
    public tools: Record<string, AgentTool<SWARM_CONTEXT>> | undefined
    public readonly uuid: string

    constructor(options: AgentOptions<SWARM_CONTEXT>) {

        const {name, description, tools, ...config} = options
        this.config = config
        this.name = name
        this.description = description
        this.tools = tools
        this.uuid = randomUUID() // agent needs a random UUID
    }

    /**
     * Render the agent's instructions
     * @param context
     */
    public getInstructions(context: SWARM_CONTEXT): string {
        if (typeof this.config.instructions === 'string') {
            return nunjucks.renderString(this.config.instructions, context)
        }
        else return this.config.instructions(context)
    }

}

export default Agent