import { JsonRpcProvider } from '@ethersproject/providers'
import { ethers, Event, Contract, BigNumber } from 'ethers'
import { MerkleTree } from 'merkletreejs'

import {
  StateRootBatchHeader,
  StateRootBatchProof,
  TransactionBatchHeader,
  TransactionBatchProof,
  TransactionChainElement,
  OvmTransaction,
} from '../../types/ovm.types'
import { fromHexString, toHexString } from '../hex-utils'

export class L1ProviderWrapper {
  constructor(
    public provider: JsonRpcProvider,
    public OVM_StateCommitmentChain: Contract,
    public OVM_CanonicalTransactionChain: Contract
  ) {}

  public async getStateRootBatchHeader(
    index: number
  ): Promise<StateRootBatchHeader> {
    const event = await this._getStateRootBatchEvent(index)

    if (!event) {
      return
    }

    return {
      batchIndex: event.args._batchIndex,
      batchRoot: event.args._batchRoot,
      batchSize: event.args._batchSize,
      prevTotalElements: event.args._prevTotalElements,
      extraData: event.args._extraData,
    }
  }

  public async getBatchStateRoots(index: number): Promise<string[]> {
    const event = await this._getStateRootBatchEvent(index)

    if (!event) {
      return
    }

    const transaction = await this.provider.getTransaction(
      event.transactionHash
    )

    const [
      stateRoots,
    ] = this.OVM_StateCommitmentChain.interface.decodeFunctionData(
      'appendStateBatch',
      transaction.data
    )

    return stateRoots
  }

  public async getStateRootBatchProof(
    index: number
  ): Promise<StateRootBatchProof> {
    const batchHeader = await this.getStateRootBatchHeader(index)
    const stateRoots = await this.getBatchStateRoots(index)

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(stateRoots.length)));
      i++
    ) {
      if (i < stateRoots.length) {
        elements.push(stateRoots[i])
      } else {
        elements.push('0x' + '00'.repeat(32))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return hash(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const batchIndex = index - batchHeader.prevTotalElements.toNumber()
    const treeProof = tree
      .getProof(leaves[batchIndex], batchIndex)
      .map((element) => {
        return element.data
      })

    return {
      stateRoot: stateRoots[batchIndex],
      stateRootBatchHeader: batchHeader,
      stateRootProof: {
        index: batchIndex,
        siblings: treeProof,
      },
    }
  }

  public async getTransactionBatchHeader(
    index: number
  ): Promise<TransactionBatchHeader> {
    const event = await this._getTransactionBatchEvent(index)

    if (!event) {
      return
    }

    return {
      batchIndex: event.args._batchIndex,
      batchRoot: event.args._batchRoot,
      batchSize: event.args._batchSize,
      prevTotalElements: event.args._prevTotalElements,
      extraData: event.args._extraData,
    }
  }

  public async getBatchTransactions(
    index: number
  ): Promise<
    Array<{
      transaction: OvmTransaction
      transactionChainElement: TransactionChainElement
    }>
  > {
    const event = await this._getTransactionBatchEvent(index)

    if (!event) {
      return
    }

    const transaction = await this.provider.getTransaction(
      event.transactionHash
    )

    if ((event as any).isSequencerBatch) {
      const transactions = []
      const txdata = fromHexString(transaction.data)
      const shouldStartAtBatch = BigNumber.from(txdata.slice(4, 9))
      const totalElementsToAppend = BigNumber.from(txdata.slice(9, 12))
      const numContexts = BigNumber.from(txdata.slice(12, 15))

      let nextTxPointer = 15 + 16 * numContexts.toNumber()
      for (let i = 0; i < numContexts.toNumber(); i++) {
        const contextPointer = 15 + 16 * i
        const context = {
          numSequencedTransactions: BigNumber.from(
            txdata.slice(contextPointer, contextPointer + 3)
          ),
          numSubsequentQueueTransactions: BigNumber.from(
            txdata.slice(contextPointer + 3, contextPointer + 6)
          ),
          ctxTimestamp: BigNumber.from(
            txdata.slice(contextPointer + 6, contextPointer + 11)
          ),
          ctxBlockNumber: BigNumber.from(
            txdata.slice(contextPointer + 11, contextPointer + 16)
          ),
        }

        for (let j = 0; j < context.numSequencedTransactions.toNumber(); j++) {
          const txDataLength = BigNumber.from(
            txdata.slice(nextTxPointer, nextTxPointer + 3)
          )
          const txData = txdata.slice(
            nextTxPointer + 3,
            nextTxPointer + 3 + txDataLength.toNumber()
          )

          transactions.push({
            transaction: {
              blockNumber: context.ctxBlockNumber.toNumber(),
              timestamp: context.ctxTimestamp.toNumber(),
              gasLimit: 7000000,
              entrypoint: '0x4200000000000000000000000000000000000005',
              l1TxOrigin: '0x' + '00'.repeat(20),
              l1QueueOrigin: 0,
              data: toHexString(txData),
            },
            transactionChainElement: {
              isSequenced: true,
              queueIndex: 0,
              timestamp: context.ctxTimestamp.toNumber(),
              blockNumber: context.ctxBlockNumber.toNumber(),
              txData: toHexString(txData),
            },
          })

          nextTxPointer += 3 + txDataLength.toNumber()
        }
      }

      return transactions
    } else {
      return []
    }
  }

  public async getTransactionBatchProof(
    index: number
  ): Promise<TransactionBatchProof> {
    const batchHeader = await this.getTransactionBatchHeader(index)
    const transactions = await this.getBatchTransactions(index)

    const elements = []
    for (
      let i = 0;
      i < Math.pow(2, Math.ceil(Math.log2(transactions.length)));
      i++
    ) {
      if (i < transactions.length) {
        // TODO: FIX
        const tx = transactions[i]
        elements.push(
          `0x01${BigNumber.from(tx.transaction.timestamp)
            .toHexString()
            .slice(2)
            .padStart(64, '0')}${BigNumber.from(tx.transaction.blockNumber)
            .toHexString()
            .slice(2)
            .padStart(64, '0')}${tx.transaction.data.slice(2)}`
        )
      } else {
        elements.push('0x' + '00'.repeat(32))
      }
    }

    const hash = (el: Buffer | string): Buffer => {
      return Buffer.from(ethers.utils.keccak256(el).slice(2), 'hex')
    }

    const leaves = elements.map((element) => {
      return hash(element)
    })

    const tree = new MerkleTree(leaves, hash)
    const batchIndex = index - batchHeader.prevTotalElements.toNumber()
    const treeProof = tree
      .getProof(leaves[batchIndex], batchIndex)
      .map((element) => {
        return element.data
      })

    return {
      transaction: transactions[batchIndex].transaction,
      transactionChainElement: transactions[batchIndex].transactionChainElement,
      transactionBatchHeader: batchHeader,
      transactionProof: {
        index: batchIndex,
        siblings: treeProof,
      },
    }
  }

  private async _getStateRootBatchEvent(index: number): Promise<Event> {
    const filter = this.OVM_StateCommitmentChain.filters.StateBatchAppended()
    const events = await this.OVM_StateCommitmentChain.queryFilter(filter)

    if (events.length === 0) {
      return
    }

    return events.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= index &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          index
      )
    })
  }

  private async _getTransactionBatchEvent(
    index: number
  ): Promise<Event & { isSequencerBatch: boolean }> {
    const filter = this.OVM_CanonicalTransactionChain.filters.TransactionBatchAppended()
    const events = await this.OVM_CanonicalTransactionChain.queryFilter(filter)

    if (events.length === 0) {
      return
    }

    const event = events.find((event) => {
      return (
        event.args._prevTotalElements.toNumber() <= index &&
        event.args._prevTotalElements.toNumber() +
          event.args._batchSize.toNumber() >
          index
      )
    })

    if (!event) {
      return
    }

    const batchSubmissionFilter = this.OVM_CanonicalTransactionChain.filters.SequencerBatchAppended()
    const batchSubmissionEvents = await this.OVM_CanonicalTransactionChain.queryFilter(
      batchSubmissionFilter
    )

    if (batchSubmissionEvents.length === 0) {
      ;(event as any).isSequencerBatch = false
    } else {
      const batchSubmissionEvent = batchSubmissionEvents.find((event) => {
        return (
          event.args._startingQueueIndex.toNumber() <= index &&
          event.args._startingQueueIndex.toNumber() +
            event.args._totalElements.toNumber() >
            index
        )
      })

      if (batchSubmissionEvent) {
        ;(event as any).isSequencerBatch = true
      } else {
        ;(event as any).isSequencerBatch = false
      }
    }

    return event as any
  }
}
