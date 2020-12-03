import { BaseTrie } from 'merkle-patricia-tree'
import * as rlp from 'rlp'

import { toHexString } from './hex-utils'

export const updateAndProve = async (
  trie: BaseTrie,
  key: Buffer,
  value: Buffer
): Promise<string> => {
  const proof = await BaseTrie.createProof(trie, key)
  const encodedProof = toHexString(rlp.encode(proof))
  await trie.put(key, value)
  return encodedProof
}
