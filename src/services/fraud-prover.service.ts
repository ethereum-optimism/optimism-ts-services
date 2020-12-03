/* Imports: External */
import { Contract, Signer, ethers } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { SecureTrie, BaseTrie } from 'merkle-patricia-tree'
import * as rlp from 'rlp'

/* Imports: Internal */
import { BaseService } from './base.service'
import {
  StateDiffProof,
  StateTransitionPhase,
  FraudProofData,
  OvmTransaction,
  StateRootBatchProof,
  TransactionBatchProof,
  AccountStateProof,
} from '../types'
import {
  sleep,
  ZERO_ADDRESS,
  loadContract,
  loadContractFromManager,
  L1ProviderWrapper,
  L2ProviderWrapper,
  toHexString,
  fromHexString,
  encodeAccountState,
  decodeAccountState,
  hashOvmTransaction,
  updateAndProve,
} from '../utils'

interface FraudProverOptions {
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider
  addressManagerAddress: string
  l1Wallet: Signer
  deployGasLimit: number
  pollingInterval: number
  fromL2TransactionIndex: number
  l2BlockOffset: number
}

export class FraudProverService extends BaseService<FraudProverOptions> {
  protected name = 'Fraud Prover'
  protected defaultOptions = {
    pollingInterval: 5000,
    deployGasLimit: 4_000_000,
    fromL2TransactionIndex: 0,
    l2BlockOffset: 1,
  }

  private state: {
    nextUnverifiedStateRoot: number
    l1Provider: L1ProviderWrapper
    l2Provider: L2ProviderWrapper
    Lib_AddressManager: Contract
    OVM_StateCommitmentChain: Contract
    OVM_CanonicalTransactionChain: Contract
    OVM_FraudVerifier: Contract
  }

  protected async _init(): Promise<void> {
    // Need to improve this, sorry.
    this.state = {} as any

    this.state.Lib_AddressManager = loadContract(
      'Lib_AddressManager',
      this.options.addressManagerAddress,
      this.options.l1RpcProvider
    )

    this.logger.info('Connecting to OVM_StateCommitmentChain...')
    this.state.OVM_StateCommitmentChain = await loadContractFromManager(
      'OVM_StateCommitmentChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_StateCommitmentChain at address: ${this.state.OVM_StateCommitmentChain.address}`
    )

    this.logger.info('Connecting to OVM_CanonicalTransactionChain...')
    this.state.OVM_CanonicalTransactionChain = await loadContractFromManager(
      'OVM_CanonicalTransactionChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_CanonicalTransactionChain at address: ${this.state.OVM_CanonicalTransactionChain.address}`
    )

    this.logger.info('Connecting to OVM_FraudVerifier...')
    this.state.OVM_FraudVerifier = await loadContractFromManager(
      'OVM_FraudVerifier',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_FraudVerifier at address: ${this.state.OVM_FraudVerifier.address}`
    )

    this.logger.success('Connected to all contracts.')

    this.state.l1Provider = new L1ProviderWrapper(
      this.options.l1RpcProvider,
      this.state.OVM_StateCommitmentChain,
      this.state.OVM_CanonicalTransactionChain
    )
    this.state.l2Provider = new L2ProviderWrapper(this.options.l2RpcProvider)

    this.state.nextUnverifiedStateRoot =
      this.options.fromL2TransactionIndex || 0
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {
        this.logger.info(`Looking for mismatched state roots...`)
        const transactionIndex = await this._findNextFraudulentTransaction()

        if (transactionIndex === undefined) {
          this.logger.info(
            `Didn't find any mismatched state roots. Trying again in ${Math.floor(
              this.options.pollingInterval / 1000
            )} seconds...`
          )
          continue
        }

        this.logger.info(`Pulling state batch header...`)
        const nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
          transactionIndex
        )

        this.logger.info(`Pulling state roots for the batch...`)
        const nextBatchStateRoots = await this.state.l1Provider.getBatchStateRoots(
          transactionIndex
        )

        this.logger.info(`Pulling fraud proof data for tx: ${transactionIndex}`)

        const proof = await this._getTxFraudProofData(transactionIndex)

        this.logger.info(`Initializing the fraud verification process...`)

        await this._initializeFraudVerification(
          proof.preStateRootProof,
          proof.transactionProof
        )

        this.logger.info(`Fraud verification process has been initialized.`)

        this.logger.info(`Loading fraud proof contracts...`)

        const {
          OVM_StateTransitioner,
          OVM_StateManager,
        } = await this._getFraudProofContracts(
          nextBatchStateRoots[
            transactionIndex - nextStateBatchHeader.prevTotalElements.toNumber()
          ],
          proof.transactionProof.transaction
        )

        this.logger.info(`Loaded fraud proof contracts.`)

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.PRE_EXECUTION
        ) {
          this.logger.info(`Proof is currently in the PRE_EXECUTION phase.`)

          await this._proveAccountStates(
            OVM_StateTransitioner,
            OVM_StateManager,
            proof.stateDiffProof.accountStateProofs
          )

          await this._proveContractStorageStates(
            OVM_StateTransitioner,
            OVM_StateManager,
            proof.stateDiffProof.accountStateProofs
          )

          this.logger.interesting(
            `Finished proving all values. Executing transaction...`
          )

          await OVM_StateTransitioner.applyTransaction(
            proof.transactionProof.transaction,
            {
              gasLimit: 8_000_000, // TODO
            }
          )

          this.logger.success(`Transaction successfully executed.`)
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.POST_EXECUTION
        ) {
          this.logger.interesting(
            `Fraud proof is now in the POST_EXECUTION phase.`
          )

          await this._updateAccountStates(
            OVM_StateTransitioner,
            OVM_StateManager,
            proof.stateDiffProof.accountStateProofs,
            proof.stateTrie
          )

          await this._updateContractStorageStates(
            OVM_StateTransitioner,
            OVM_StateManager,
            proof.stateDiffProof.accountStateProofs,
            proof.stateTrie,
            proof.storageTries
          )

          this.logger.success(
            `All updates were committed. Completing the state transition...`
          )

          await OVM_StateTransitioner.completeTransition()

          this.logger.success(`State transition completed.`)
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.COMPLETE
        ) {
          this.logger.interesting(`Fraud proof is now in the COMPLETE phase.`)
          this.logger.info(`Attempting to finalize the fraud proof...`)

          await this._finalizeFraudVerification(
            proof.preStateRootProof,
            proof.postStateRootProof,
            proof.transactionProof.transaction
          )

          this.logger.success(`Fraud proof finalized! Congrats.`)
        }
      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  private async _findNextFraudulentTransaction(): Promise<number> {
    let nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
      this.state.nextUnverifiedStateRoot
    )

    if (nextStateBatchHeader === undefined) {
      return
    }

    let transactionIndex: number = undefined
    while (
      nextStateBatchHeader !== undefined &&
      transactionIndex === undefined
    ) {
      const nextBatchStateRoots = await this.state.l1Provider.getBatchStateRoots(
        this.state.nextUnverifiedStateRoot
      )

      this.logger.info(`Checking for any mismatched state roots...`)
      for (let i = 0; i < nextStateBatchHeader.batchSize.toNumber(); i++) {
        const l1StateRoot = nextBatchStateRoots[i]
        const l1StateRootIndex = this.state.nextUnverifiedStateRoot + i

        this.logger.info(
          `Checking state root for mismatch: ${l1StateRootIndex}`
        )
        const l2StateRoot = await this.state.l2Provider.getStateRoot(
          l1StateRootIndex + this.options.l2BlockOffset
        )

        if (l1StateRoot !== l2StateRoot) {
          transactionIndex = l1StateRootIndex
          this.logger.interesting(
            `Found a mismatched state root at index ${transactionIndex}!`
          )
          this.logger.interesting(
            `State root published to Layer 1 was: ${l1StateRoot}`
          )
          this.logger.interesting(
            `State root published to Layer 2 was: ${l2StateRoot}`
          )
          this.logger.interesting(`Starting the fraud proof process...`)
          break
        } else {
          this.logger.info(`No state root mismatch, checking the next root.`)
        }
      }

      if (transactionIndex === undefined) {
        this.state.nextUnverifiedStateRoot += nextStateBatchHeader.batchSize.toNumber()
      } else {
        break
      }

      this.logger.info(
        `Moving on to the next batch, starting with state root index: ${this.state.nextUnverifiedStateRoot}`
      )
      nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
        this.state.nextUnverifiedStateRoot
      )
    }

    return transactionIndex
  }

  /**
   * Generates all transaction proof data for a given transaction index.
   * @param transactionIndex Transaction index to get proof data for.
   * @return Transaction proof data.
   */
  private async _getTxFraudProofData(
    transactionIndex: number
  ): Promise<FraudProofData> {
    const proof: StateDiffProof = await this.state.l2Provider.getStateDiffProof(
      transactionIndex + this.options.l2BlockOffset
    )

    const senderProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset,
      '0xe84578fbA927D32760CB978C32bAd03069cCbDD2',
      ['0x0000000000000000000000000000000000000000000000000000000000000000']
    )

    proof.accountStateProofs.push(senderProof)

    const gasProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset,
      '0x06a506a506a506a506a506a506a506a506a506a5',
      ['0x0000000000000000000000000000000000000000000000000000000000000002']
    )

    const acc = proof.accountStateProofs.find((account) => {
      return account.address === '0x06a506a506a506a506a506a506a506a506a506a5'
    })

    acc.storageProof = acc.storageProof.concat(gasProof.storageProof)

    const entrypointProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset,
      '0x4200000000000000000000000000000000000005',
      []
    )

    proof.accountStateProofs.push(entrypointProof)

    const ecdsaProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset,
      '0x4200000000000000000000000000000000000003',
      []
    )

    proof.accountStateProofs.push(ecdsaProof)

    const preStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      transactionIndex
    )

    const postStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      transactionIndex + 1
    )

    const transactionProof = await this.state.l1Provider.getTransactionBatchProof(
      transactionIndex
    )

    const stateTrie = await this._makeStateTrie(proof)
    const storageTries = await this._makeAccountTries(proof)

    return {
      stateDiffProof: proof,
      transactionProof,
      preStateRootProof,
      postStateRootProof,
      stateTrie,
      storageTries,
    }
  }

  private async _getFraudProofContracts(
    preStateRoot: string,
    transaction: OvmTransaction
  ): Promise<{
    OVM_StateTransitioner: Contract
    OVM_StateManager: Contract
  }> {
    this.logger.info(`Loading the state transitioner...`)

    const stateTransitionerAddress = await this._getStateTransitioner(
      preStateRoot,
      transaction
    )

    const OVM_StateTransitioner = loadContract(
      'OVM_StateTransitioner',
      stateTransitionerAddress,
      this.options.l1RpcProvider
    ).connect(this.options.l1Wallet)

    this.logger.info(
      `State transitioner is at address: ${stateTransitionerAddress}`
    )

    this.logger.info(`Loading the corresponding state manager...`)

    const stateManagerAddress = await OVM_StateTransitioner.ovmStateManager()
    const OVM_StateManager = loadContract(
      'OVM_StateManager',
      stateManagerAddress,
      this.options.l1RpcProvider
    ).connect(this.options.l1Wallet)

    this.logger.info(`State manager is at address: ${stateManagerAddress}`)

    return {
      OVM_StateTransitioner,
      OVM_StateManager,
    }
  }

  /**
   * Generates a view of the state trie from a state diff proof.
   * @param proof State diff proof to generate a trie from.
   * @return View of the state trie.
   */
  private async _makeStateTrie(proof: StateDiffProof): Promise<BaseTrie> {
    const firstRootNode = proof.accountStateProofs[0].accountProof[0]
    const allNonRootNodes: string[] = proof.accountStateProofs.reduce(
      (nodes, account) => {
        return nodes.concat(account.accountProof.slice(1))
      },
      []
    )
    const allNodes = [firstRootNode].concat(allNonRootNodes).map((el) => {
      return Buffer.from(el.slice(2), 'hex')
    })

    return BaseTrie.fromProof(allNodes)
  }

  /**
   * Generates a view of a set of account tries from a state diff proof.
   * @param proof State diff proof to generate tries from.
   * @return View of a set of all account tries.
   */
  private async _makeAccountTries(
    proof: StateDiffProof
  ): Promise<{
    [address: string]: SecureTrie
  }> {
    const witnessMap = proof.accountStateProofs.reduce(
      (
        map: {
          [address: string]: Buffer[]
        },
        account
      ) => {
        const ovmContractAddress = account.address
        if (!(ovmContractAddress in map)) {
          if (account.storageProof.length > 0) {
            if (account.storageProof[0].proof.length > 0) {
              map[ovmContractAddress] = [
                Buffer.from(account.storageProof[0].proof[0].slice(2), 'hex'),
              ]
            } else {
              map[ovmContractAddress] = []
            }
          } else {
            map[ovmContractAddress] = []
          }
        }

        map[ovmContractAddress] = map[ovmContractAddress].concat(
          account.storageProof.reduce((nodes, storageProof) => {
            nodes = nodes.concat(
              storageProof.proof.slice(1).map((el) => {
                return Buffer.from(el.slice(2), 'hex')
              })
            )

            return nodes
          }, [])
        )

        return map
      },
      {}
    )

    const accountTries = {}
    for (const ovmContractAddress of Object.keys(witnessMap)) {
      const proof = witnessMap[ovmContractAddress]
      accountTries[ovmContractAddress] = await BaseTrie.fromProof(proof)
    }

    return accountTries
  }

  /**
   * Retrieves the state transitioner correspondng to a given pre-state root and transaction.
   * @param preStateRoot Pre-state root to retreive a state transitioner for.
   * @param transaction Transaction to retreive a state transitioner for.
   * @return Address of the corresponding state transitioner.
   */
  private async _getStateTransitioner(
    preStateRoot: string,
    transaction: OvmTransaction
  ): Promise<string> {
    return this.state.OVM_FraudVerifier.getStateTransitioner(
      preStateRoot,
      hashOvmTransaction(transaction)
    )
  }

  /**
   * Simple mechanism for deploying an exact bytecode to a given address. Resulting contract will
   * have code exactly matching the given `code` variable, and none of the code will be executed
   * during creation.
   * @param code Code to store at a given address.
   * @return Address of the newly created contract.
   */
  private async _deployContractCode(code: string): Promise<string> {
    // "Magic" prefix to be prepended to the contract code. Contains a series of opcodes that will
    // copy the given code into memory and return it, thereby storing at the contract address.
    const prefix = '0x600D380380600D6000396000f3'
    const deployCode = prefix + toHexString(code).slice(2)

    const response = await this.options.l1Wallet.sendTransaction({
      to: null,
      data: deployCode,
      gasLimit: this.options.deployGasLimit,
    })

    const result = await response.wait()
    return result.contractAddress
  }

  /**
   * Proves the state of all given accounts.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   */
  private async _proveAccountStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[]
  ): Promise<void> {
    for (const accountStateProof of accountStateProofs) {
      this.logger.info(
        `Checking if we've already proven account: ${accountStateProof.address}`
      )

      const existingAccount = await OVM_StateManager.getAccount(
        accountStateProof.address
      )

      if (existingAccount.codeHash === accountStateProof.codeHash) {
        this.logger.info(
          `Account has already been proven, skipping: ${accountStateProof.address}`
        )
        continue
      }

      this.logger.interesting(
        `Account has not been proven. Grabbing code to deploy a copy...`
      )

      const accountCode = await this.options.l2RpcProvider.getCode(
        accountStateProof.address
      )

      this.logger.info(`Deploying a copy of the code of the account...`)

      const ethContractAddress = await this._deployContractCode(accountCode)

      this.logger.info(`Attempting to prove the state of the account...`)

      await OVM_StateTransitioner.proveContractState(
        accountStateProof.address,
        ethContractAddress,
        {
          nonce: accountStateProof.nonce,
          balance: accountStateProof.balance,
          storageRoot: accountStateProof.storageHash,
          codeHash: accountStateProof.codeHash,
        },
        rlp.encode(accountStateProof.accountProof)
      )

      this.logger.success(`Finished proving account state.`)
    }
  }

  /**
   * Proves all contract storage slot states.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   */
  private async _proveContractStorageStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[]
  ): Promise<void> {
    for (const accountStateProof of accountStateProofs) {
      if (accountStateProof.storageProof.length > 0) {
        this.logger.interesting(
          `Moving on to prove storage slots for the account.`
        )
      }

      for (const slot of accountStateProof.storageProof) {
        this.logger.info(`Trying to prove the value of slot: ${slot.key}`)
        this.logger.info(`Value is: ${slot.value}`)

        this.logger.info(
          `Checking if we've already proven the given storage slot: ${slot.key}...`
        )

        const existingSlotValue = await OVM_StateManager.getContractStorage(
          accountStateProof.address,
          slot.key
        )

        if (
          existingSlotValue ===
          '0x' + slot.value.slice(2).padStart(64, '0')
        ) {
          this.logger.info(`Slot value has already been proven, skipping.`)
        } else {
          this.logger.info(
            `Slot value has not been proven, attempting to prove it now...`
          )

          await OVM_StateTransitioner.proveStorageSlot(
            accountStateProof.address,
            '0x' + slot.key.slice(2).padStart(64, '0'),
            '0x' + slot.value.slice(2).padStart(64, '0'),
            rlp.encode(slot.proof)
          )

          this.logger.success(
            `Proved storage slot value, moving on to the next slot.`
          )
        }
      }
    }
  }

  /**
   * Commits all account state changes.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   * @param stateTrie State trie view generated from proof data.
   */
  private async _updateAccountStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[],
    stateTrie: BaseTrie
  ): Promise<void> {
    for (const accountStateProof of accountStateProofs) {
      this.logger.info(
        `Account was changed during execution: ${accountStateProof.address}`
      )

      this.logger.info(`Pulling account state from state manager...`)

      const newAccountState = await OVM_StateManager.getAccount(
        accountStateProof.address
      )

      const oldAccountState = decodeAccountState(
        await stateTrie.get(
          fromHexString(ethers.utils.keccak256(accountStateProof.address))
        )
      )

      if (
        !(await OVM_StateManager.wasAccountChanged(accountStateProof.address))
      ) {
        this.logger.info(`Account was not changed, skipping...`)
        continue
      }

      const updateProof = await updateAndProve(
        stateTrie,
        fromHexString(ethers.utils.keccak256(accountStateProof.address)),
        encodeAccountState({
          ...oldAccountState,
          ...{
            nonce: newAccountState.nonce.toNumber(),
            codeHash: newAccountState.codeHash,
          },
        })
      )

      this.logger.info(`Trying to commit the updated account state...`)

      if (
        await OVM_StateManager.wasAccountCommitted(accountStateProof.address)
      ) {
        this.logger.interesting(`Account was already committed, skipping...`)
      }

      try {
        await OVM_StateTransitioner.commitContractState(
          accountStateProof.address,
          updateProof,
          {
            gasLimit: this.options.deployGasLimit,
          }
        )

        this.logger.success(
          `Updated account state committed, moving on to storage slots.`
        )
      } catch (err) {
        if (!err.toString().includes('was not changed or has already')) {
          throw err
        } else {
          this.logger.interesting(`Account was already committed, skipping...`)
        }
      }
    }
  }

  /**
   * Commits all contract storage slot changes.
   * @param OVM_StateTransitioner Ethers contract instance pointed at the state transitioner.
   * @param OVM_StateManager Ethers contract instance pointed at the state manager.
   * @param accountStateProofs All account state proofs.
   * @param stateTrie State trie view generated from proof data.
   * @param storageTries Storage trie views generated from proof data.
   */
  private async _updateContractStorageStates(
    OVM_StateTransitioner: Contract,
    OVM_StateManager: Contract,
    accountStateProofs: AccountStateProof[],
    stateTrie: BaseTrie,
    storageTries: {
      [address: string]: BaseTrie
    }
  ) {
    for (const accountStateProof of accountStateProofs) {
      const oldAccountState = decodeAccountState(
        await stateTrie.get(
          fromHexString(ethers.utils.keccak256(accountStateProof.address))
        )
      )

      for (const storageProof of accountStateProof.storageProof) {
        this.logger.info(`Slot was mutated: ${storageProof.key}`)

        const trie = storageTries[accountStateProof.address]

        this.logger.info(`Pulling the new slot value...`)

        const updatedSlotValue = await OVM_StateManager.getContractStorage(
          accountStateProof.address,
          storageProof.key
        )

        if (
          !OVM_StateManager.wasContractStorageChanged(
            accountStateProof.address,
            storageProof.key
          )
        ) {
          this.logger.info(`Slot was not changed, skipping...`)
          continue
        }

        const storageTrieProof = await updateAndProve(
          trie,
          fromHexString(ethers.utils.keccak256(storageProof.key)),
          fromHexString(rlp.encode(updatedSlotValue))
        )

        const newAccountState = {
          ...oldAccountState,
          storageRoot: toHexString(trie.root),
        }

        const stateTrieProof = await updateAndProve(
          stateTrie,
          fromHexString(ethers.utils.keccak256(accountStateProof.address)),
          encodeAccountState(newAccountState)
        )

        this.logger.info(`Trying to commit the new slot value...`)

        if (
          await OVM_StateManager.wasContractStorageCommitted(
            accountStateProof.address,
            storageProof.key
          )
        ) {
          this.logger.interesting(
            `Contract storage was already committed, skipping...`
          )
        }

        try {
          await OVM_StateTransitioner.connect(
            this.options.l1Wallet
          ).commitStorageSlot(
            accountStateProof.address,
            storageProof.key,
            stateTrieProof,
            storageTrieProof,
            {
              gasLimit: this.options.deployGasLimit,
            }
          )

          this.logger.success(`New slot value committed successfully.`)
        } catch (err) {
          if (!err.toString().includes('not changed or has already been')) {
            throw err
          } else {
            this.logger.interesting(
              `Contract storage was already committed, skipping...`
            )
          }
        }
      }
    }
  }

  /**
   * Initializes the fraud verification process.
   * @param preStateRootProof Proof data for the pre-state root.
   * @param transactionProof Proof data for the transaction being verified.
   */
  private async _initializeFraudVerification(
    preStateRootProof: StateRootBatchProof,
    transactionProof: TransactionBatchProof
  ): Promise<void> {
    const stateTransitionerAddress = await this._getStateTransitioner(
      preStateRootProof.stateRoot,
      transactionProof.transaction
    )

    if (stateTransitionerAddress !== ZERO_ADDRESS) {
      return
    }

    await this.state.OVM_FraudVerifier.connect(
      this.options.l1Wallet
    ).initializeFraudVerification(
      preStateRootProof.stateRoot,
      preStateRootProof.stateRootBatchHeader,
      preStateRootProof.stateRootProof,
      transactionProof.transaction,
      transactionProof.transactionChainElement,
      transactionProof.transactionBatchHeader,
      transactionProof.transactionProof
    )
  }

  /**
   * Finalizes the fraud verification process.
   * @param preStateRootProof Proof data for the pre-state root.
   * @param postStateRootProof Proof data for the post-state root.
   * @param transaction Transaction being verified.
   */
  private async _finalizeFraudVerification(
    preStateRootProof: StateRootBatchProof,
    postStateRootProof: StateRootBatchProof,
    transaction: OvmTransaction
  ): Promise<void> {
    await this.state.OVM_FraudVerifier.connect(
      this.options.l1Wallet
    ).finalizeFraudVerification(
      preStateRootProof.stateRoot,
      preStateRootProof.stateRootBatchHeader,
      preStateRootProof.stateRootProof,
      hashOvmTransaction(transaction),
      postStateRootProof.stateRoot,
      postStateRootProof.stateRootBatchHeader,
      postStateRootProof.stateRootProof
    )
  }
}
