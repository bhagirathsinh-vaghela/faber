import { Identifier } from "./identifier"

// Both searches run over lists the server ordered with Identifier.compare, so
// they order by the same key. A lexical comparison here would disagree with
// that order for ids of different time-field widths and land a message at the
// wrong index.
export namespace Binary {
  export function search<T>(array: T[], id: string, compare: (item: T) => string): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const order = Identifier.compare(compare(array[mid]), id)

      if (order === 0) {
        return { found: true, index: mid }
      } else if (order < 0) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }

  export function insert<T>(array: T[], item: T, compare: (item: T) => string): T[] {
    const id = compare(item)
    let left = 0
    let right = array.length

    while (left < right) {
      const mid = Math.floor((left + right) / 2)

      if (Identifier.compare(compare(array[mid]), id) < 0) {
        left = mid + 1
      } else {
        right = mid
      }
    }

    array.splice(left, 0, item)
    return array
  }
}
