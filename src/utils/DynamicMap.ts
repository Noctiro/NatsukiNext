/**
 * DynamicMap - A custom Map class that provides support for dynamic default values and entry expiration.
 * 
 * This class extends functionality beyond the native JavaScript Map and adds the following features:
 * 
 * 1. **Default Value Handling**: 
 *    If you attempt to access a key that doesn't exist, it will automatically create and store a default value.
 *    - `defaultData` can be a static value, an object with static and dynamic fields, or a function (including classes).
 *    - If `defaultData` is a class, it will instantiate the class when a new key is accessed.
 *    - If `defaultData` is a function, it will call the function dynamically to generate the default value.
 *    - If `defaultData` is an object, it can contain dynamic fields (like functions) that are executed each time a new key is accessed, allowing for dynamic default values.
 * 
 * 2. **Dynamic Value Support**:
 *    For objects passed as `defaultData`, if any field contains a function, it will be executed when a new key is accessed, allowing dynamic values like timestamps.
 * 
 * 3. **Arguments Support**:
 *    Additional arguments passed to the constructor (`...args`) can be used in the creation of new values, particularly for class instantiation or function calls.
 *
 * 4. **Entry Expiration**:
 *    Entries can be set to expire after a specified time period, with automatic cleanup of expired entries.
 * 
 * @example
 * // Example 1: Using DynamicMap with a static default value
 * const staticMap = new DynamicMap('default');
 * await staticMap.get('key1'); // Returns 'default'
 * 
 * @example
 * // Example 2: Using DynamicMap with a dynamic function as defaultData
 * const funcMap = new DynamicMap(() => Math.random());
 * await funcMap.get('key1'); // Returns a random number
 * 
 * @example
 * // Example 3: Using DynamicMap with a class as defaultData
 * class User {
 *   constructor(name: string) {
 *     this.name = name;
 *     this.createdAt = new Date();
 *   }
 * }
 * const userMap = new DynamicMap(User, 'Anonymous');
 * await userMap.get('user1'); // Returns a new User instance with the name 'Anonymous'
 * 
 * @example
 * // Example 4: Using DynamicMap with an object containing dynamic fields
 * const defaultData = {
 *   createdAt: () => new Date().toISOString(), // Dynamic field
 *   name: 'Unknown', // Static field
 * };
 * const objectMap = new DynamicMap(defaultData);
 * await objectMap.get('user1'); // Returns { createdAt: '2024-10-07T12:34:56.789Z', name: 'Unknown' }
 * 
 * @example
 * // Example 5: Using DynamicMap with expiry time
 * const expiringMap = new DynamicMap('default', 3600000); // Entries expire after 1 hour
 * expiringMap.set('key1', 'value1');
 * // After 1 hour, key1 will be automatically removed
 * 
 * @class
 * @template K - The key type
 * @template V - The value type
 * @template A - The type of additional arguments
 */
export default class DynamicMap<K = any, V = any, A extends any[] = any[]> {
    private map: Map<K, V> = new Map();
    private defaultData: any;
    private args: A;
    private expiryTimes?: Map<K, number>;
    private expiryMs?: number;
    private cleanupInterval;

    /**
     * Creates a new DynamicMap instance.
     * 
     * @param defaultData - The default value, function, class, or object to create default values for missing keys.
     * @param expiryMs - Optional. The time in milliseconds after which entries expire.
     * @param args - Additional arguments to pass to the default data function or class constructor.
     */
    constructor(defaultData: any, expiryMs?: number, ...args: A) {
        this.defaultData = defaultData;
        this.args = args;

        // If expiry time is provided, set up expiration handling
        if (expiryMs && expiryMs > 0) {
            this.expiryMs = expiryMs;
            this.expiryTimes = new Map();
            
            // Set up cleanup interval (minimum once per minute, or at the expiry time if shorter)
            this.cleanupInterval = setInterval(() => {
                this.cleanup();
            }, Math.min(60000, expiryMs));
        }
    }

    /**
     * Retrieves the value for the given key. If the key does not exist in the map,
     * it generates a new value based on the defaultData and stores it in the map.
     *
     * @param key - The key to retrieve the value for.
     * @returns A Promise resolving to the value associated with the key, or the generated default value.
     */
    async get(key: K): Promise<V> {
        if (this.has(key)) {
            return this.map.get(key)!;
        } else {
            const value = await this._createDefaultValue();
            this.set(key, value);
            return value;
        }
    }

    /**
     * Synchronously retrieves the value for the given key.
     * Unlike the async get method, this does not create a default value if the key doesn't exist.
     * Instead, it returns the raw defaultData without processing it.
     *
     * @param key - The key to retrieve the value for.
     * @returns The value associated with the key, or the raw defaultData.
     */
    getSync(key: K): V {
        return this.map.has(key) ? this.map.get(key)! : this.defaultData as V;
    }

    /**
     * Sets a value for the specified key and updates its expiry time if expiry is enabled.
     * 
     * @param key - The key to set.
     * @param value - The value to associate with the key.
     * @returns This DynamicMap instance, for chaining.
     */
    set(key: K, value: V): this {
        this.map.set(key, value);
        
        // If expiry is enabled, update the expiry time
        if (this.expiryTimes) {
            this.expiryTimes.set(key, Date.now());
        }
        
        return this;
    }

    /**
     * Resets a specific key to its default value.
     * If the key does not exist, it will create and set the default value.
     *
     * @param key - The key to reset.
     * @returns A Promise resolving to the new default value set for the key.
     */
    async reset(key: K): Promise<V> {
        const value = await this._createDefaultValue();
        this.set(key, value);
        return value;
    }

    /**
     * Checks if the map contains the specified key.
     * 
     * @param key - The key to check.
     * @returns True if the key exists, false otherwise.
     */
    has(key: K): boolean {
        return this.map.has(key);
    }

    /**
     * Deletes the specified key and its associated value from the map.
     * 
     * @param key - The key to delete.
     * @returns True if the element was removed, false if the key was not found.
     */
    delete(key: K): boolean {
        if (this.expiryTimes) {
            this.expiryTimes.delete(key);
        }
        return this.map.delete(key);
    }

    /**
     * Removes all key-value pairs from the map.
     */
    clear(): void {
        this.map.clear();
        if (this.expiryTimes) {
            this.expiryTimes.clear();
        }
    }

    /**
     * Returns an iterator of all keys in the map.
     * 
     * @returns An iterator of all keys.
     */
    keys(): IterableIterator<K> {
        return this.map.keys();
    }

    /**
     * Returns an iterator of all values in the map.
     * 
     * @returns An iterator of all values.
     */
    values(): IterableIterator<V> {
        return this.map.values();
    }

    /**
     * Returns an iterator of all key-value pairs in the map.
     * 
     * @returns An iterator of all key-value pairs.
     */
    entries(): IterableIterator<[K, V]> {
        return this.map.entries();
    }

    /**
     * Returns the number of key-value pairs in the map.
     * 
     * @returns The number of elements in the map.
     */
    get size(): number {
        return this.map.size;
    }

    /**
     * Returns the raw default data used to generate default values.
     * 
     * @returns The default data.
     */
    getDefaultData(): any {
        return this.defaultData;
    }

    /**
     * Changes the default value or generator for this DynamicMap.
     * 
     * @param newDefaultData - The new default value, function, class, or object.
     * @param args - Optional new arguments to pass to the default data function or class.
     */
    setDefaultData(newDefaultData: any, ...args: A): void {
        this.defaultData = newDefaultData;
        if (args.length > 0) {
            this.args = args;
        }
    }

    /**
     * Changes the expiry time for all future entries.
     * This does not affect existing entries.
     * 
     * @param expiryMs - The new expiry time in milliseconds. Set to undefined to disable expiry.
     */
    setExpiryTime(expiryMs?: number): void {
        // Clear existing expiry setup if any
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }

        if (expiryMs && expiryMs > 0) {
            this.expiryMs = expiryMs;
            
            // Create expiry times map if it doesn't exist
            if (!this.expiryTimes) {
                this.expiryTimes = new Map();
            }
            
            // Set up new cleanup interval
            this.cleanupInterval = setInterval(() => {
                this.cleanup();
            }, Math.min(60000, expiryMs));
        } else {
            this.expiryMs = undefined;
            this.expiryTimes = undefined;
        }
    }

    /**
     * Refreshes the expiry time for a specific key.
     * 
     * @param key - The key to refresh.
     * @returns True if the key exists and was refreshed, false otherwise.
     */
    refreshExpiry(key: K): boolean {
        if (this.has(key) && this.expiryTimes) {
            this.expiryTimes.set(key, Date.now());
            return true;
        }
        return false;
    }

    /**
     * Executes a callback for each key-value pair in the map.
     * 
     * @param callbackFn - Function to execute for each element.
     * @param thisArg - Value to use as 'this' when executing callback.
     */
    forEach(callbackFn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void {
        this.map.forEach(callbackFn, thisArg);
    }

    /**
     * Cleans up expired entries based on the configured expiry time.
     * @private
     */
    private cleanup(): void {
        if (!this.expiryTimes || !this.expiryMs) return;
        
        const now = Date.now();
        for (const [key, time] of this.expiryTimes.entries()) {
            if (now - time > this.expiryMs) {
                this.delete(key);
            }
        }
    }

    /**
     * Generates a default value based on the type of defaultData.
     * @private
     * @returns A Promise resolving to the generated default value.
     */
    private async _createDefaultValue(): Promise<V> {
        let create: V;

        // Handle defaultData as a function or a class
        if (typeof this.defaultData === 'function') {
            try {
                // Check if it's a class (via `new`)
                create = new this.defaultData(...this.args);
            } catch (error) {
                // If not a class, assume it's a function and call it
                create = await this.defaultData(...this.args);
            }
        } else if (typeof this.defaultData === 'object' && this.defaultData !== null) {
            // Handle defaultData as an object with dynamic fields
            create = this._parseDynamicValues(this.defaultData) as V;
        } else {
            // DefaultData is a static value
            create = this.defaultData as V;
        }

        return create;
    }

    /**
     * Parses dynamic values within the defaultData object.
     * If a field's value is a function, it will be executed to generate a dynamic value.
     * @private
     * @param data - The object to parse for dynamic values.
     * @returns A new object with the dynamic values resolved.
     */
    private _parseDynamicValues(data: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(data)) {
            // If the value is a function, execute it
            result[key] = typeof value === 'function' ? value() : value;
        }
        return result;
    }

    /**
     * Cleans up resources and prevents memory leaks when the instance is no longer needed.
     * This should be called when you're done with the DynamicMap instance.
     */
    destroy(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
        this.clear();
    }

    /**
     * Creates a DynamicMap with a specific expiry time for entries in seconds.
     * 
     * @param defaultData - The default value, function, class, or object for missing keys.
     * @param expirySeconds - Time in seconds after which entries expire.
     * @param args - Additional arguments for the default data generator.
     * @returns A new DynamicMap instance with the specified expiry time.
     */
    static withExpirySeconds<K, V, A extends any[]>(
        defaultData: any, 
        expirySeconds: number, 
        ...args: A
    ): DynamicMap<K, V, A> {
        return new DynamicMap<K, V, A>(defaultData, expirySeconds * 1000, ...args);
    }
}