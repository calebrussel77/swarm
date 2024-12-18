/**
 * Deep-copy an object using JSON.parse and JSON.stringify. This will not work for complex objects, and may be slow
 * as your object size increases
 * @param object
 */
export function deepCopy<T>(object: any): T{
    return JSON.parse(JSON.stringify(object))
}


export class DefaultRecord<K extends string | number | symbol, V> {

    private readonly defaultFactory: () => V
    private readonly innerRecord: Record<K, V>

    constructor(defaultFactory: () => V, init: Record<K, V>={} as Record<K, V>) {
        this.defaultFactory = defaultFactory
        this.innerRecord = {...init}
    }

    public get(key: K): V {
        if (!(key in this.innerRecord)) {
            this.innerRecord[key] = this.defaultFactory()
        }
        return this.innerRecord[key]
    }

    public set(key: K, value: V): void {
        this.innerRecord[key] = value
    }

    public has(key: K): boolean {
        return key in this.innerRecord
    }

    public delete(key: K): boolean {
        return delete this.innerRecord[key]
    }

    public keys(): Array<K> {
        return Object.keys(this.innerRecord) as Array<K>
    }

    public values(): Array<V> {
        return Object.values(this.innerRecord)
    }

    public entries(): Array<[K, V]> {
        return Object.entries(this.innerRecord) as Array<[K, V]>
    }

    public toRecord(): Record<K, V> {
        return {...this.innerRecord}
    }
}