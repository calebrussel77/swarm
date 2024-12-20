import type {LanguageModel} from 'ai'
import {openai} from '@ai-sdk/openai'
import type {Agent} from './agent'
import {Swarm, type SwarmMessage} from './swarm'

export type HiveOptions<HIVE_CONTEXT extends object> = {
    defaultModel?: LanguageModel
    queen: Agent<HIVE_CONTEXT>
    defaultContext?: HIVE_CONTEXT
}

export type HiveCreateSwarmOptions<SWARM_CONTEXT extends object> = {
    defaultModel?: LanguageModel
    messages?: Array<SwarmMessage>
    queen?: Agent<SWARM_CONTEXT>
    defaultContext?: SWARM_CONTEXT
}
/**
 * A **Hive** represents something like a "Swarm Factory". It looks like a static configuration, from which new
 * **Swarm**s can be created with their own internal state and context.
 */
export class Hive<HIVE_CONTEXT extends object = any> {

    private readonly defaultModel: LanguageModel
    readonly queen: Agent<HIVE_CONTEXT>
    readonly defaultInitialContext?: HIVE_CONTEXT

    constructor(options: HiveOptions<HIVE_CONTEXT>) {
        this.defaultModel = options.defaultModel || openai('gpt-40-mini')
        this.queen = options.queen
        this.defaultInitialContext = options.defaultContext
    }

    /**
     * Spawn a swarm from the hive
     * @param options
     */
    public spawnSwarm(options?: HiveCreateSwarmOptions<HIVE_CONTEXT>): Swarm<HIVE_CONTEXT> {

        if ((!this.defaultInitialContext) && (!options?.defaultContext)) throw new Error(
            `Unable to create swarm from Hive: default context for swarm must be passed in Hive() or in Hive.swarm()`
        )
        return new Swarm<HIVE_CONTEXT>({
            defaultModel: options?.defaultModel || this.defaultModel,
            queen: options?.queen || this.queen,
            initialContext: (options?.defaultContext || this.defaultInitialContext)!,
            messages: options?.messages
        })
    }
}