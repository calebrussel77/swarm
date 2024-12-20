import {describe, test, expect} from 'bun:test'
import Agent from '../src/agent'

describe('Agent Initialization tests', () => {

    test('Create a simple agent', () => {

        expect(() => new Agent({
            name: 'Example agent',
            description: 'A simple agent that answers user queries',
            instructions: 'You are a helpful assistant',
        })).not.toThrowError()
    })
})

