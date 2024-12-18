import z from 'zod'
import type {
    CoreTool,
    LanguageModelV1
} from 'ai'
import {jsonValueSchema} from './common.schemas'


export const agentOptionsSchema = z.object({
    name: z.string()
        .describe('The agent\'s name. Distinct from the model ID; useful for debugging'),
    description: z.string()
        .describe('Describe what the agent does; used to inform other agents of it\'s capabilities'),
    languageModel: z.custom<LanguageModelV1>()
        .optional()
        .describe('The language model to use for the agent. If not specified, reverts to swarm default.'),
    instructions: z.union([
        z.string().describe('The system prompt string, or nunjucks template'), // String OR nunjucks template
        z.function()
            .args(z.record(z.string(), jsonValueSchema))
            .returns(z.string())
            .describe('A function that receives the current context, and returns the system prompt')
    ])
        .describe('The system prompt string, nunjucks template string, or function that returns the system prompt from context'),
    tools: z.record(z.string(), z.custom<CoreTool>())
        .optional()
        .transform(val => val ?? {} satisfies Record<string, CoreTool>)
        .describe('Tools that can be invoked by the agent.'),
    toolChoice: z.union([
        z.enum(['auto', 'none', 'required']),
        z.object({
            type: z.literal('string'),
            toolName: z.string()
        })
    ])
        .optional()
        .describe('Define how the model should call tools.'),
    maxTokens: z.number()
        .optional(),
    temperature: z.number()
        .min(0)
        .optional(),
    maxTurns: z.number()
        .optional()
})
    .refine((agentOptions) => !(
        agentOptions.tools &&
        agentOptions.toolChoice &&
        typeof agentOptions.toolChoice !== 'string' &&
        !Object.keys(agentOptions.tools).includes(agentOptions.toolChoice.toolName)
    ), {
        message: 'Tool choice must specify a tool that is passed to the agent.',
        path: ['toolChoice']
    })
    .refine((agentOptions) => !(
        // When tools are not defined and yet tool choice is defined and set to something other than "none"
        agentOptions.tools &&
        Object.keys(agentOptions.tools).length === 0 && !(
            agentOptions.toolChoice !== undefined || agentOptions.toolChoice !== 'none'
        )
    ), {
        message: 'Tool choice may not be specified when there are no tools.'
    })
export type AgentOptions = z.input<typeof agentOptionsSchema>
export type ParsedAgentOptions = z.infer<typeof agentOptionsSchema>

export const agentInvocationSchema = z.object({
    command: z.literal('transfer_to_agent'),
    uuid: z.string().length(36)
})

export type AgentInvocation = z.infer<typeof agentInvocationSchema>