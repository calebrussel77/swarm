import {describe, expect, test} from 'bun:test'
import {Swarm} from '../src'
import {openai} from '@ai-sdk/openai'
import {Agent} from '../src/agent'


describe('Swarm Initialization tests', () => {

    test('Create a swarm with an agent should succeed', () => {

        let agent: Agent
        let swarm: Swarm

        expect(() => {
            agent = new Agent({
                name: 'Haiku writer',
                description: 'Always responds in haikus',
                instructions: 'Write a haiku in response to the user\'s request',
            })
        }).not.toThrowError()

        expect(() => {
            swarm = new Swarm({
                defaultLanguageModel: openai('gpt-4o-mini'),
                name: 'Test Swarm',
                leader: agent,
                agents: [agent]
            })
        }).not.toThrowError()
    })
})

