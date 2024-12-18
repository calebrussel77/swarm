import type {CoreAssistantMessage, CoreMessage, CoreSystemMessage, CoreToolMessage, CoreUserMessage} from 'ai'

// Array of core messages where each has a sender representing the n
export type SwarmMessage = (CoreAssistantMessage & {sender?: string}) | CoreUserMessage | CoreToolMessage | CoreSystemMessage