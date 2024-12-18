import type {JSONValue, LanguageModel, LanguageModelV1} from 'ai'
import type {Agent} from './agent'
import {
    type HiveCreateSwarmOptions,
    hiveCreateSwarmOptionsSchema,
    type HiveOptions,
    hiveOptionsSchema
} from './schemas/hive.schemas'
import {Swarm} from './swarm'
import type {SwarmMessage} from './types'

/**
 * A **Hive** represents something like a "Swarm Factory". It looks like a static configuration, from which new
 * **Swarm**s can be created with their own internal state and context.
 */
export class Hive {

    private readonly defaultLanguageModel: LanguageModelV1
    public readonly queen: Agent
    private readonly defaultContext: Record<string, JSONValue>
    public agents: Array<Agent>

    constructor(options: HiveOptions) {

        const hiveOptions = hiveOptionsSchema.parse(options)
        this.defaultLanguageModel = hiveOptions.defaultLanguageModel
        this.queen = hiveOptions.queen
        this.defaultContext = hiveOptions.defaultContext
        this.agents = hiveOptions.agents
    }

    /**
     * Initialize a new swarm with its' own context; pattered on the hive.
     * agent entrypoint etc. can be overridden.
     * @param options
     */
    public createSwarm(options?: HiveCreateSwarmOptions): Swarm {
        const swarmCreationOptions = hiveCreateSwarmOptionsSchema.parse(options)
        return new Swarm({
            defaultLanguageModel: swarmCreationOptions.defaultLanguageModel || this.defaultLanguageModel,
            messages: swarmCreationOptions.messages || [] satisfies Array<SwarmMessage>,
            leader: swarmCreationOptions.leader || this.queen,
            initialContext: {
                ...this.defaultContext,
                ...swarmCreationOptions.updatedContext
            },
            agents: swarmCreationOptions.agents ?? this.agents
        })
    }
}