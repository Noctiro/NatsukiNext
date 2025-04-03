/**
 * Represents a range within a string.
 */
class Range {
    public start: number;
    public end: number;
    public length: number;

    constructor(start: number, end: number) {
        this.start = start;
        this.end = end;
        this.length = end - start;
    }

    /**
     * Checks if this range overlaps with another range.
     * @param other The other range to check against.
     * @returns True if the ranges overlap, false otherwise.
     */
    overlaps(other: Range): boolean {
        return this.start < other.end && this.end > other.start;
    }

    /**
     * Checks if a position is contained within this range.
     * @param position The position to check.
     * @returns True if the position is within the range, false otherwise.
     */
    contains(position: number): boolean {
        return position >= this.start && position < this.end;
    }
}

/**
 * Represents a repeated substring found in the text.
 */
class RepeatedSubstring {
    public content: string;
    public positions: number[];
    public length: number;
    private textLength: number; // Keep total text length for penalty calculation

    constructor(content: string, firstPosition: number, textLength: number) {
        this.content = content;
        this.positions = [firstPosition];
        this.length = content.length;
        this.textLength = textLength;
    }

    /**
     * Adds a new position where this substring occurs.
     * @param position The starting position of the occurrence.
     */
    addPosition(position: number): void {
        this.positions.push(position);
    }

    /**
     * Gets the number of times this substring is repeated.
     */
    get count(): number {
        return this.positions.length;
    }

    /**
     * Calculates the penalty score for this repeated substring.
     * The score considers length, frequency, and overall text coverage.
     * @returns The calculated penalty score.
     */
    calculatePenalty(): number {
        // Avoid division by zero or log(0) for very short texts
        if (this.textLength <= 1) return 0;

        // Length ratio: Penalize longer repeats more, scaled by sqrt of text length
        const lengthRatio = Math.min(this.length / Math.sqrt(this.textLength), 0.5);

        // Coverage ratio: Logarithmic scale to account for diminishing impact of coverage
        // Add small constants to avoid log(0) or log(1) issues
        const coverageRatio = Math.log2(1 + (this.length * this.count)) / Math.log2(3 + this.textLength);

        // Repeat factor: Exponential growth based on count
        const repeatFactor = Math.pow(this.count, 1.5) / 10;

        // Base score combines the factors
        const baseScore = lengthRatio * (1 + coverageRatio) * repeatFactor;

        // Apply a modified sigmoid for smoother scaling between 0 and 1
        const normalizedScore = this.modifiedSigmoid(baseScore * 5); // Multiplier adjusts sensitivity

        // Final score scaling
        return normalizedScore * 3;
    }

    /**
     * A modified sigmoid function for smoother score distribution.
     * @param x The input value (base score).
     * @returns A value between 0 and 1.
     */
    private modifiedSigmoid(x: number): number {
        // Adjust k to control the steepness of the curve
        const k = 0.5;
        return 1 / (1 + Math.exp(-k * x));
    }
}

/**
 * Detects repeated substrings within a given text.
 */
class SubstringDetector {
    private input: string;
    private minLength: number;
    private repeats: Map<string, RepeatedSubstring>;
    private coveredRanges: Range[]; // Stores ranges covered by *longer* detected repeats
    private totalLength: number;
    private adjustedMinLength: number; // Dynamically adjusted minimum length

    constructor(input: string, minLength: number = 2) {
        this.input = input;
        this.minLength = minLength;
        this.repeats = new Map<string, RepeatedSubstring>();
        this.coveredRanges = [];
        this.totalLength = input.length;

        // Dynamically adjust minLength based on text length, ensuring it's reasonable
        this.adjustedMinLength = Math.max(
            this.minLength,
            Math.min(Math.ceil(Math.log2(this.totalLength) / 2), 10) // Add an upper cap to adjustedMinLength
        );
        // Ensure adjustedMinLength is at least 2
        this.adjustedMinLength = Math.max(2, this.adjustedMinLength);
    }

    /**
     * Checks if a potential substring range overlaps with already covered ranges.
     * @param position Start position of the potential substring.
     * @param length Length of the potential substring.
     * @returns True if the range is covered, false otherwise.
     */
    private isPositionCovered(position: number, length: number): boolean {
        const newRange = new Range(position, position + length);
        // Optimization: Could potentially use a more efficient data structure (like an interval tree)
        // if coveredRanges becomes very large, but for typical text, linear scan is often sufficient.
        for (const range of this.coveredRanges) {
            if (range.overlaps(newRange)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Marks a range as covered by a detected repeated substring.
     * @param position Start position of the range.
     * @param length Length of the range.
     */
    private markRangeCovered(position: number, length: number): void {
        // Optimization: Could merge overlapping/adjacent ranges here if needed.
        this.coveredRanges.push(new Range(position, position + length));
    }

    /**
     * Finds all starting positions of a substring within the input text
     * that are not already covered by longer repeats.
     * Uses KMP algorithm for efficient searching.
     * @param substr The substring to search for.
     * @param length The length of the substring.
     * @param kmpTable Precomputed KMP failure function table for the substring.
     * @returns An array of valid starting positions.
     */
    private findValidPositions(substr: string, length: number, kmpTable: number[]): number[] {
        const positions: number[] = [];
        let searchStartIndex = 0; // Where to start the next search in the input text

        while (searchStartIndex <= this.totalLength - length) {
            const foundIndex = this.kmpSearch(substr, kmpTable, searchStartIndex);

            if (foundIndex === -1) {
                break; // No more occurrences found
            }

            // Check if this specific occurrence is covered by a *longer* repeat found earlier
            if (!this.isPositionCovered(foundIndex, length)) {
                positions.push(foundIndex);
            }

            // Start the next search immediately after the current find
            // Optimization: If we want to find non-overlapping occurrences only, use `foundIndex + length`
            // But the current logic aims to find all occurrences, letting `markRangeCovered` handle overlaps.
            searchStartIndex = foundIndex + 1;
        }

        return positions;
    }

    /**
     * Builds the KMP failure function (partial match table).
     * @param pattern The substring (pattern) to build the table for.
     * @returns The KMP failure function table.
     */
    private buildKMPTable(pattern: string): number[] {
        const patternLength = pattern.length;
        const table: number[] = new Array(patternLength).fill(0);
        let prefixLen = 0; // Length of the previous longest prefix suffix
        let i = 1;

        // table[0] is always 0, so we start from i = 1
        while (i < patternLength) {
            if (pattern[i] === pattern[prefixLen]) {
                prefixLen++;
                table[i] = prefixLen;
                i++;
            } else {
                // This is tricky. Consider the example.
                // AAACAAAA and i = 7. The idea is similar
                // to search step below
                if (prefixLen !== 0) {
                    prefixLen = table[prefixLen - 1]!;
                    // Also, note that we do not increment i here
                } else {
                    table[i] = 0;
                    i++;
                }
            }
        }
        return table;
    }

    /**
     * Performs KMP search for a pattern within the input text starting from a given position.
     * @param pattern The substring to search for.
     * @param table The precomputed KMP failure function table.
     * @param startPos The position in the input text to start searching from.
     * @returns The starting index of the first match found at or after startPos, or -1 if not found.
     */
    private kmpSearch(pattern: string, table: number[], startPos: number): number {
        const patternLength = pattern.length;
        let patternIndex = 0; // index for pattern[]
        let textIndex = startPos; // index for input[]

        while (textIndex < this.totalLength) {
            if (pattern[patternIndex] === this.input[textIndex]) {
                patternIndex++;
                textIndex++;
            }

            if (patternIndex === patternLength) {
                // Found a match
                return textIndex - patternIndex;
                // To find subsequent matches, you'd update patternIndex:
                // patternIndex = table[patternIndex - 1];
            } else if (textIndex < this.totalLength && pattern[patternIndex] !== this.input[textIndex]) {
                // Mismatch after patternIndex matches
                // Do not match table[0..table[patternIndex-1]] characters,
                // they will match anyway
                if (patternIndex !== 0) {
                    patternIndex = table[patternIndex - 1]!;
                } else {
                    textIndex++;
                }
            }
        }

        return -1; // Pattern not found
    }

    /**
     * Detects all repeated substrings meeting the criteria and calculates the total penalty.
     * @param debug If true, prints detailed debug information to the console.
     * @returns The total penalty score for repeated substrings.
     */
    detect(debug: boolean = false): number {
        // Performance consideration: For extremely long texts, suffix arrays/trees
        // might be faster but have higher memory overhead and complexity.
        // KMP-based approach is a good balance for moderately long texts.

        // Adjust max length based on text length, with a hard cap
        const maxLength = Math.min(
            Math.floor(this.totalLength / 2),
            150 // Increased absolute upper limit slightly
        );

        let totalPenalty = 0;
        let totalCoverageLength = 0; // Sum of lengths of all covered segments

        // Iterate from longest potential repeats down to the adjusted minimum length
        for (let strLen = maxLength; strLen >= this.adjustedMinLength; strLen--) {
            // Optimization: Precompute KMP tables outside the inner loop if the same substring is checked multiple times.
            // However, the current structure iterates through starting positions, generating unique substrings initially.
            // The `repeats.has(substr)` check prevents reprocessing identical substrings.

            // Dynamic step based on length - larger steps for longer substrings
            const step = Math.max(1, Math.floor(strLen / 5)); // Adjusted step logic

            for (let i = 0; i <= this.totalLength - strLen; i += step) {
                // Crucial Optimization: Skip if the starting position `i` is already part of a longer repeat found earlier.
                if (this.isPositionCovered(i, strLen)) {
                    continue;
                }

                const substr = this.input.slice(i, i + strLen);

                // Skip if this exact substring has already been processed and added to repeats
                if (this.repeats.has(substr)) {
                    continue;
                }

                // Filter out trivial or invalid substrings early
                if (!this.isValidSubstring(substr)) {
                    continue;
                }

                // Build KMP table once for the current substring candidate
                const kmpTable = this.buildKMPTable(substr);

                // Find all valid (uncovered) positions of this substring
                const positions = this.findValidPositions(substr, strLen, kmpTable);

                // Only consider it a repeat if found more than once
                if (positions.length > 1) {
                    const repeated = new RepeatedSubstring(substr, positions[0]!, this.totalLength);
                    // Add remaining positions
                    for (let k = 1; k < positions.length; k++) {
                        repeated.addPosition(positions[k]!);
                    }

                    this.repeats.set(substr, repeated);

                    // Mark all occurrences of this *newly found* repeat as covered
                    // This prevents shorter substrings contained within this one from being counted separately.
                    positions.forEach(pos => this.markRangeCovered(pos, strLen));

                    // Accumulate penalty and coverage
                    const penalty = repeated.calculatePenalty();
                    totalPenalty += penalty;
                    totalCoverageLength += positions.length * strLen; // Rough coverage estimate
                }
            }
        }

        // Final penalty adjustment based on overall coverage ratio
        // Use log scale to moderate the impact of coverage
        const coverageRatio = this.totalLength > 0 ? Math.log2(1 + totalCoverageLength) / Math.log2(1 + this.totalLength) : 0;
        // Apply a power to coverageRatio to adjust its influence (e.g., > 1 increases influence, < 1 decreases)
        const finalPenalty = totalPenalty * (1 + Math.pow(Math.min(coverageRatio, 1.0), 1.2)); // Ensure ratio doesn't exceed 1

        if (debug) {
            this.printDebugInfo(coverageRatio, finalPenalty);
        }

        // Normalize the final score to a 0-100 range perhaps? Or leave as is?
        // For now, return the calculated penalty. Could add normalization later.
        // Example normalization: 100 * (1 - 1 / (1 + finalPenalty / SENSITIVITY_FACTOR))
        return finalPenalty;
    }

    /**
     * Checks if a substring is considered valid for repetition analysis.
     * Filters out whitespace, single-character repeats, low-entropy strings, etc.
     * @param substr The substring to check.
     * @returns True if the substring is valid, false otherwise.
     */
    private isValidSubstring(substr: string): boolean {
        const trimmed = substr.trim();
        // Ignore empty or whitespace-only strings
        if (!trimmed) return false;

        // Ignore simple single-character repetitions (e.g., "aaaa", "---")
        if (/^(.)\1+$/.test(trimmed)) return false;

        // Ignore very low entropy strings (e.g., "ababab") if they are long enough
        // Check unique characters relative to length
        if (substr.length > 4 && new Set(substr).size <= 2) return false;
        if (substr.length > 10 && new Set(substr).size <= 3) return false;


        // Ignore all-numeric or all-punctuation strings (can be adjusted)
        if (/^\d+$/.test(trimmed)) return false;
        // Expanded punctuation check
        if (/^[\p{P}\p{S}]+$/u.test(trimmed)) return false; // Using Unicode property escapes

        return true;
    }

    /**
     * Prints debug information about found repeats and scores.
     * @param coverageRatio Calculated coverage ratio.
     * @param finalPenalty The final calculated penalty score.
     */
    private printDebugInfo(coverageRatio: number, finalPenalty: number): void {
        if (this.repeats.size === 0) {
            console.log('No significant repeated substrings found.');
            return;
        }

        console.log('\n--- Repeated Substring Analysis ---');
        console.log(`Input Text Length: ${this.totalLength}`);
        console.log(`Adjusted Min Length: ${this.adjustedMinLength}`);
        console.log(`Overall Coverage Ratio (log-scaled): ${(coverageRatio * 100).toFixed(2)}%`);
        console.log(`Final Penalty Score: ${finalPenalty.toFixed(4)}`);
        console.log('------------------------------------');
        console.log('Detected Repeats (sorted by penalty):');

        const sortedRepeats = [...this.repeats.values()]
            .sort((a, b) => b.calculatePenalty() - a.calculatePenalty());

        sortedRepeats.forEach(repeat => {
            const score = repeat.calculatePenalty();
            // Calculate coverage percentage for this specific repeat
            const individualCoverage = this.totalLength > 0 ? (repeat.length * repeat.count / this.totalLength) * 100 : 0;

            console.log(
                `  - "${repeat.content}" (Len: ${repeat.length}, Count: ${repeat.count})` +
                `\n    Coverage: ${individualCoverage.toFixed(2)}%, Score: ${score.toFixed(4)}` +
                `\n    Positions: [${repeat.positions.join(', ')}]`
            );
        });
        console.log('------------------------------------\n');
    }
}

/**
 * Detects non-contiguous repeated substrings in a string and calculates a penalty score.
 * The score reflects the severity of repetition based on length, frequency, and coverage.
 *
 * @param input The input string to analyze.
 * @param debug Optional: Set to true to enable detailed console logging for debugging. (Default: false)
 * @param minLength Optional: The minimum length of substring to consider as a repeat. (Default: 5, dynamically adjusted based on input length)
 * @returns A numerical penalty score indicating the degree of repetition. Higher scores mean more significant repetition.
 */
export function detectRepeatedSubstrings(input: string, debug: boolean = false, minLength: number = 5): number {
    if (!input || input.length < minLength * 2) {
        // Basic check: If the input is too short to contain a repeat of minLength, return 0
        return 0;
    }
    const detector = new SubstringDetector(input, minLength);
    return detector.detect(debug);
}
