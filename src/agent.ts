import {type AgentOptions, agentOptionsSchema} from './schemas/agent.schemas.ts'
import {type CoreTool, type JSONValue, tool} from 'ai'
import nunjucks from 'nunjucks'
import z from 'zod'
import {createLogger} from './logger.ts'

const logger = createLogger(__filename)

export class Agent {

    private config: Omit<AgentOptions, 'name' | 'description'>
    public name: string
    public description: string

    constructor(options: AgentOptions) {

        const {name, description, ...config } = agentOptionsSchema.parse(options)
        this.config = config
        this.name = name
        this.description = description
    }

    /**
     * Render the agent's instructions
     * @param context
     */
    public getInstructions(context: Record<string, JSONValue>): string {
        if (typeof this.config.instructions === 'string') {
            return nunjucks.renderString(this.config.instructions, context)
        }
        else return this.config.instructions(context)
    }

    /**
     * Convert the agent to a tool so that it can be dispatched by another agent
     * @param toolDescription - the description for the tool to dispatch this agent. E.g. it may describe when to call
     * this tool to dispatch the agent
     */
    public dispatchTool(toolDescription?: string) {
        return tool({
            description: toolDescription || `Dispatch agent "${this.name}". About this agent: ${this.description}`,
            parameters: z.object({}),
            execute: async ({}) => {
                logger.info(`Trying to dispatch agent ${this.name}`)
            }
        })
    }
}

export default Agent