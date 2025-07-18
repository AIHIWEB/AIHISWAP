import { splitSignature } from '@ethersproject/bytes'
import { Contract } from '@ethersproject/contracts'
import { Percent, WETH } from '@AIHISwap/sdk'
import React, { useCallback, useContext, useState } from 'react'
import { ArrowDown, Plus } from 'react-feather'
import ReactGA from 'react-ga'
import { RouteComponentProps } from 'react-router'
import { Text } from 'rebass'
import { ThemeContext } from 'styled-components'
import { ButtonPrimary, ButtonLight, ButtonError, ButtonConfirmed } from '../../components/Button'
import { LightCard } from '../../components/Card'
import { AutoColumn, ColumnCenter } from '../../components/Column'
import ConfirmationModal from '../../components/ConfirmationModal'
import CurrencyInputPanel from '../../components/CurrencyInputPanel'
import DoubleLogo from '../../components/DoubleLogo'
import PositionCard from '../../components/PositionCard'
import Row, { RowBetween, RowFixed } from '../../components/Row'

import Slider from '../../components/Slider'
import TokenLogo from '../../components/TokenLogo'
import { ROUTER_ADDRESS } from '../../constants'
import { useActiveWeb3React } from '../../hooks'
import { usePairContract } from '../../hooks/useContract'

import { useTransactionAdder } from '../../state/transactions/hooks'
import { TYPE } from '../../theme'
import { calculateGasMargin, calculateSlippageAmount, getRouterContract } from '../../utils'
import AppBody from '../AppBody'
import { ClickableText, MaxButton, Wrapper } from '../Pool/styleds'
import { useApproveCallback, ApprovalState } from '../../hooks/useApproveCallback'
import { Dots } from '../../components/swap/styleds'
import { useDefaultsFromURLMatchParams, useBurnActionHandlers } from '../../state/burn/hooks'
import { useDerivedBurnInfo, useBurnState } from '../../state/burn/hooks'
import { Field } from '../../state/burn/actions'
import { useWalletModalToggle } from '../../state/application/hooks'
import { useUserDeadline, useUserSlippageTolerance } from '../../state/user/hooks'
import { BigNumber } from '@ethersproject/bignumber'

export default function RemoveLiquidity({ match: { params } }: RouteComponentProps<{ tokens: string }>) {
  useDefaultsFromURLMatchParams(params)

  const { account, chainId, library } = useActiveWeb3React()
  const theme = useContext(ThemeContext)

  // toggle wallet when disconnected
  const toggleWalletModal = useWalletModalToggle()

  // burn state
  const { independentField, typedValue } = useBurnState()
  const { tokens, pair, route, parsedAmounts, error } = useDerivedBurnInfo()
  const { onUserInput: _onUserInput } = useBurnActionHandlers()
  const isValid = !error

  // modal and loading
  const [showConfirm, setShowConfirm] = useState<boolean>(false)
  const [showDetailed, setShowDetailed] = useState<boolean>(false)
  const [attemptingTxn, setAttemptingTxn] = useState(false) // clicked confirm

  // txn values
  const [txHash, setTxHash] = useState<string>('')
  const [deadline] = useUserDeadline()
  const [allowedSlippage] = useUserSlippageTolerance()

  const formattedAmounts = {
    [Field.LIQUIDITY_PERCENT]: parsedAmounts[Field.LIQUIDITY_PERCENT].equalTo('0')
      ? '0'
      : parsedAmounts[Field.LIQUIDITY_PERCENT].lessThan(new Percent('1', '100'))
      ? '<1'
      : parsedAmounts[Field.LIQUIDITY_PERCENT].toFixed(0),
    [Field.LIQUIDITY]:
      independentField === Field.LIQUIDITY ? typedValue : parsedAmounts[Field.LIQUIDITY]?.toSignificant(6) ?? '',
    [Field.TOKEN_A]:
      independentField === Field.TOKEN_A ? typedValue : parsedAmounts[Field.TOKEN_A]?.toSignificant(6) ?? '',
    [Field.TOKEN_B]:
      independentField === Field.TOKEN_B ? typedValue : parsedAmounts[Field.TOKEN_B]?.toSignificant(6) ?? ''
  }

  const atMaxAmount = parsedAmounts[Field.LIQUIDITY_PERCENT]?.equalTo(new Percent('1'))

  // pair contract
  const pairContract: Contract = usePairContract(pair?.liquidityToken?.address)

  // allowance handling
  const [signatureData, setSignatureData] = useState<{ v: number; r: string; s: string; deadline: number }>(null)
  const [approval, approveCallback] = useApproveCallback(parsedAmounts[Field.LIQUIDITY], ROUTER_ADDRESS)
  async function onAttemptToApprove() {
    // try to gather a signature for permission
    const nonce = await pairContract.nonces(account)
    const deadlineForSignature: number = Math.ceil(Date.now() / 1000) + deadline

    const EIP712Domain = [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' }
    ]
    const domain = {
      name: 'AIHISwap V2',
      version: '1',
      chainId: chainId,
      verifyingContract: pair.liquidityToken.address
    }
    const Permit = [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
    const message = {
      owner: account,
      spender: ROUTER_ADDRESS,
      value: parsedAmounts[Field.LIQUIDITY].raw.toString(),
      nonce: nonce.toHexString(),
      deadline: deadlineForSignature
    }
    const data = JSON.stringify({
      types: {
        EIP712Domain,
        Permit
      },
      domain,
      primaryType: 'Permit',
      message
    })

    library
      .send('eth_signTypedData_v4', [account, data])
      .then(splitSignature)
      .then(signature => {
        setSignatureData({
          v: signature.v,
          r: signature.r,
          s: signature.s,
          deadline: deadlineForSignature
        })
      })
      .catch(error => {
        // for all errors other than 4001 (EIP-1193 user rejected request), fall back to manual approve
        if (error?.code !== 4001) {
          approveCallback()
        }
      })
  }

  // wrapped onUserInput to clear signatures
  const onUserInput = useCallback(
    (field: Field, typedValue: string) => {
      setSignatureData(null)
      return _onUserInput(field, typedValue)
    },
    [_onUserInput]
  )

  // tx sending
  const addTransaction = useTransactionAdder()
  async function onRemove() {
    const router = getRouterContract(chainId, library, account)

    const amountsMin = {
      [Field.TOKEN_A]: calculateSlippageAmount(parsedAmounts[Field.TOKEN_A], allowedSlippage)[0],
      [Field.TOKEN_B]: calculateSlippageAmount(parsedAmounts[Field.TOKEN_B], allowedSlippage)[0]
    }

    const tokenBIsETH = tokens[Field.TOKEN_B].equals(WETH[chainId])
    const oneTokenIsETH = tokens[Field.TOKEN_A].equals(WETH[chainId]) || tokenBIsETH

    const deadlineFromNow = Math.ceil(Date.now() / 1000) + deadline

    let methodNames: string[], args: Array<string | string[] | number | boolean>
    // we have approval, use normal remove liquidity
    if (approval === ApprovalState.APPROVED) {
      // removeLiquidityETH
      if (oneTokenIsETH) {
        methodNames = ['removeLiquidityETH', 'removeLiquidityETHSupportingFeeOnTransferTokens']
        args = [
          tokens[tokenBIsETH ? Field.TOKEN_A : Field.TOKEN_B].address,
          parsedAmounts[Field.LIQUIDITY].raw.toString(),
          amountsMin[tokenBIsETH ? Field.TOKEN_A : Field.TOKEN_B].toString(),
          amountsMin[tokenBIsETH ? Field.TOKEN_B : Field.TOKEN_A].toString(),
          account,
          deadlineFromNow
        ]
      }
      // removeLiquidity
      else {
        methodNames = ['removeLiquidity']
        args = [
          tokens[Field.TOKEN_A].address,
          tokens[Field.TOKEN_B].address,
          parsedAmounts[Field.LIQUIDITY].raw.toString(),
          amountsMin[Field.TOKEN_A].toString(),
          amountsMin[Field.TOKEN_B].toString(),
          account,
          deadlineFromNow
        ]
      }
    }
    // we have a signataure, use permit versions of remove liquidity
    else if (signatureData !== null) {
      // removeLiquidityETHWithPermit
      if (oneTokenIsETH) {
        methodNames = ['removeLiquidityETHWithPermit', 'removeLiquidityETHWithPermitSupportingFeeOnTransferTokens']
        args = [
          tokens[tokenBIsETH ? Field.TOKEN_A : Field.TOKEN_B].address,
          parsedAmounts[Field.LIQUIDITY].raw.toString(),
          amountsMin[tokenBIsETH ? Field.TOKEN_A : Field.TOKEN_B].toString(),
          amountsMin[tokenBIsETH ? Field.TOKEN_B : Field.TOKEN_A].toString(),
          account,
          signatureData.deadline,
          false,
          signatureData.v,
          signatureData.r,
          signatureData.s
        ]
      }
      // removeLiquidityETHWithPermit
      else {
        methodNames = ['removeLiquidityWithPermit']
        args = [
          tokens[Field.TOKEN_A].address,
          tokens[Field.TOKEN_B].address,
          parsedAmounts[Field.LIQUIDITY].raw.toString(),
          amountsMin[Field.TOKEN_A].toString(),
          amountsMin[Field.TOKEN_B].toString(),
          account,
          signatureData.deadline,
          false,
          signatureData.v,
          signatureData.r,
          signatureData.s
        ]
      }
    } else {
      console.error('Attempting to confirm without approval or a signature. Please contact support.')
    }

    const safeGasEstimates = await Promise.all(
      methodNames.map(methodName =>
        router.estimateGas[methodName](...args)
          .then(calculateGasMargin)
          .catch(error => {
            console.error(`estimateGas failed for ${methodName}`, error)
          })
      )
    )

    const indexOfSuccessfulEstimation = safeGasEstimates.findIndex(safeGasEstimate =>
      BigNumber.isBigNumber(safeGasEstimate)
    )

    // all estimations failed...
    if (indexOfSuccessfulEstimation === -1) {
      console.error('This transaction would fail. Please contact support.')
    } else {
      const methodName = methodNames[indexOfSuccessfulEstimation]
      const safeGasEstimate = safeGasEstimates[indexOfSuccessfulEstimation]

      setAttemptingTxn(true)
      await router[methodName](...args, {
        gasLimit: safeGasEstimate
      })
        .then(response => {
          setAttemptingTxn(false)

          addTransaction(response, {
            summary:
              'Remove ' +
              parsedAmounts[Field.TOKEN_A]?.toSignificant(3) +
              ' ' +
              tokens[Field.TOKEN_A]?.symbol +
              ' and ' +
              parsedAmounts[Field.TOKEN_B]?.toSignificant(3) +
              ' ' +
              tokens[Field.TOKEN_B]?.symbol
          })

          setTxHash(response.hash)

          ReactGA.event({
            category: 'Liquidity',
            action: 'Remove',
            label: [tokens[Field.TOKEN_A]?.symbol, tokens[Field.TOKEN_B]?.symbol].join('/')
          })
        })
        .catch(error => {
          setAttemptingTxn(false)
          // we only care if the error is something _other_ than the user rejected the tx
          if (error?.code !== 4001) {
            console.error(error)
          }
        })
    }
  }

  function modalHeader() {
    return (
      <AutoColumn gap={'md'} style={{ marginTop: '20px' }}>
        <RowBetween align="flex-end">
          <Text fontSize={24} fontWeight={500}>
            {parsedAmounts[Field.TOKEN_A]?.toSignificant(6)}
          </Text>
          <RowFixed gap="4px">
            <TokenLogo address={tokens[Field.TOKEN_A]?.address} size={'24px'} />
            <Text fontSize={24} fontWeight={500} style={{ marginLeft: '10px' }}>
              {tokens[Field.TOKEN_A]?.symbol}
            </Text>
          </RowFixed>
        </RowBetween>
        <RowFixed>
          <Plus size="16" color={theme.text2} />
        </RowFixed>
        <RowBetween align="flex-end">
          <Text fontSize={24} fontWeight={500}>
            {parsedAmounts[Field.TOKEN_B]?.toSignificant(6)}
          </Text>
          <RowFixed gap="4px">
            <TokenLogo address={tokens[Field.TOKEN_B]?.address} size={'24px'} />
            <Text fontSize={24} fontWeight={500} style={{ marginLeft: '10px' }}>
              {tokens[Field.TOKEN_B]?.symbol}
            </Text>
          </RowFixed>
        </RowBetween>

        <TYPE.italic fontSize={12} color={theme.text2} textAlign="left" padding={'12px 0 0 0'}>
          {`Output is estimated. If the price changes by more than ${allowedSlippage /
            100}% your transaction will revert.`}
        </TYPE.italic>
      </AutoColumn>
    )
  }

  function modalBottom() {
    return (
      <>
        <RowBetween>
          <Text color={theme.text2} fontWeight={500} fontSize={16}>
            {'UNI ' + tokens[Field.TOKEN_A]?.symbol + '/' + tokens[Field.TOKEN_B]?.symbol} Burned
          </Text>
          <RowFixed>
            <DoubleLogo
              a0={tokens[Field.TOKEN_A]?.address || ''}
              a1={tokens[Field.TOKEN_B]?.address || ''}
              margin={true}
            />
            <Text fontWeight={500} fontSize={16}>
              {parsedAmounts[Field.LIQUIDITY]?.toSignificant(6)}
            </Text>
          </RowFixed>
        </RowBetween>
        {route && (
          <>
            <RowBetween>
              <Text color={theme.text2} fontWeight={500} fontSize={16}>
                Price
              </Text>
              <Text fontWeight={500} fontSize={16} color={theme.text1}>
                1 {tokens[Field.TOKEN_A]?.symbol} = {route.midPrice.toSignificant(6)} {tokens[Field.TOKEN_B]?.symbol}
              </Text>
            </RowBetween>
            <RowBetween>
              <div />
              <Text fontWeight={500} fontSize={16} color={theme.text1}>
                1 {tokens[Field.TOKEN_B]?.symbol} = {route.midPrice.invert().toSignificant(6)}{' '}
                {tokens[Field.TOKEN_A]?.symbol}
              </Text>
            </RowBetween>
          </>
        )}
        <ButtonPrimary disabled={!(approval === ApprovalState.APPROVED || signatureData !== null)} onClick={onRemove}>
          <Text fontWeight={500} fontSize={20}>
            Confirm
          </Text>
        </ButtonPrimary>
      </>
    )
  }

  const pendingText = `Removing ${parsedAmounts[Field.TOKEN_A]?.toSignificant(6)} ${
    tokens[Field.TOKEN_A]?.symbol
  } and ${parsedAmounts[Field.TOKEN_B]?.toSignificant(6)} ${tokens[Field.TOKEN_B]?.symbol}`

  const liquidityPercentChangeCallback = useCallback(
    (value: number) => {
      onUserInput(Field.LIQUIDITY_PERCENT, value.toString())
    },
    [onUserInput]
  )

  return (
    <>
      <AppBody>
        <Wrapper>
          <ConfirmationModal
            isOpen={showConfirm}
            onDismiss={() => {
              setShowConfirm(false)
              setSignatureData(null) // important that we clear signature data to avoid bad sigs
              // if there was a tx hash, we want to clear the input
              if (txHash) {
                onUserInput(Field.LIQUIDITY_PERCENT, '0')
              }
              setTxHash('')
            }}
            attemptingTxn={attemptingTxn}
            hash={txHash ? txHash : ''}
            topContent={modalHeader}
            bottomContent={modalBottom}
            pendingText={pendingText}
            title="You will receive"
          />
          <AutoColumn gap="md">
            <LightCard>
              <AutoColumn gap="20px">
                <RowBetween>
                  <Text fontWeight={500}>Amount</Text>
                  <ClickableText
                    fontWeight={500}
                    onClick={() => {
                      setShowDetailed(!showDetailed)
                    }}
                  >
                    {showDetailed ? 'Simple' : 'Detailed'}
                  </ClickableText>
                </RowBetween>
                <Row style={{ alignItems: 'flex-end' }}>
                  <Text fontSize={72} fontWeight={500}>
                    {formattedAmounts[Field.LIQUIDITY_PERCENT]}%
                  </Text>
                </Row>
                {!showDetailed && (
                  <>
                    <Slider
                      value={Number.parseInt(parsedAmounts[Field.LIQUIDITY_PERCENT].toFixed(0))}
                      onChange={liquidityPercentChangeCallback}
                    />
                    <RowBetween>
                      <MaxButton onClick={() => onUserInput(Field.LIQUIDITY_PERCENT, '25')} width="20%">
                        25%
                      </MaxButton>
                      <MaxButton onClick={() => onUserInput(Field.LIQUIDITY_PERCENT, '50')} width="20%">
                        50%
                      </MaxButton>
                      <MaxButton onClick={() => onUserInput(Field.LIQUIDITY_PERCENT, '75')} width="20%">
                        75%
                      </MaxButton>
                      <MaxButton onClick={() => onUserInput(Field.LIQUIDITY_PERCENT, '100')} width="20%">
                        Max
                      </MaxButton>
                    </RowBetween>
                  </>
                )}
              </AutoColumn>
            </LightCard>
            {!showDetailed && (
              <>
                <ColumnCenter>
                  <ArrowDown size="16" color={theme.text2} />
                </ColumnCenter>
                <LightCard>
                  <AutoColumn gap="10px">
                    <RowBetween>
                      <Text fontSize={24} fontWeight={500}>
                        {formattedAmounts[Field.TOKEN_A] || '-'}
                      </Text>
                      <RowFixed>
                        <TokenLogo address={tokens[Field.TOKEN_A]?.address} style={{ marginRight: '12px' }} />
                        <Text fontSize={24} fontWeight={500} id="remove-liquidity-tokena-symbol">
                          {tokens[Field.TOKEN_A]?.symbol}
                        </Text>
                      </RowFixed>
                    </RowBetween>
                    <RowBetween>
                      <Text fontSize={24} fontWeight={500}>
                        {formattedAmounts[Field.TOKEN_B] || '-'}
                      </Text>
                      <RowFixed>
                        <TokenLogo address={tokens[Field.TOKEN_B]?.address} style={{ marginRight: '12px' }} />
                        <Text fontSize={24} fontWeight={500} id="remove-liquidity-tokenb-symbol">
                          {tokens[Field.TOKEN_B]?.symbol}
                        </Text>
                      </RowFixed>
                    </RowBetween>
                  </AutoColumn>
                </LightCard>
              </>
            )}

            {showDetailed && (
              <>
                <CurrencyInputPanel
                  field={Field.LIQUIDITY}
                  value={formattedAmounts[Field.LIQUIDITY]}
                  onUserInput={onUserInput}
                  onMax={() => {
                    onUserInput(Field.LIQUIDITY_PERCENT, '100')
                  }}
                  showMaxButton={!atMaxAmount}
                  disableTokenSelect
                  token={pair?.liquidityToken}
                  isExchange={true}
                  pair={pair}
                  id="liquidity-amount"
                />
                <ColumnCenter>
                  <ArrowDown size="16" color={theme.text2} />
                </ColumnCenter>
                <CurrencyInputPanel
                  hideBalance={true}
                  field={Field.TOKEN_A}
                  value={formattedAmounts[Field.TOKEN_A]}
                  onUserInput={onUserInput}
                  onMax={() => onUserInput(Field.LIQUIDITY_PERCENT, '100')}
                  showMaxButton={!atMaxAmount}
                  token={tokens[Field.TOKEN_A]}
                  label={'Output'}
                  disableTokenSelect
                  id="remove-liquidity-tokena"
                />
                <ColumnCenter>
                  <Plus size="16" color={theme.text2} />
                </ColumnCenter>
                <CurrencyInputPanel
                  hideBalance={true}
                  field={Field.TOKEN_B}
                  value={formattedAmounts[Field.TOKEN_B]}
                  onUserInput={onUserInput}
                  onMax={() => onUserInput(Field.LIQUIDITY_PERCENT, '100')}
                  showMaxButton={!atMaxAmount}
                  token={tokens[Field.TOKEN_B]}
                  label={'Output'}
                  disableTokenSelect
                  id="remove-liquidity-tokenb"
                />
              </>
            )}
            {route && (
              <div style={{ padding: '10px 20px' }}>
                <RowBetween>
                  Price:
                  <div>
                    1 {tokens[Field.TOKEN_A]?.symbol} = {route.midPrice.toSignificant(6)}{' '}
                    {tokens[Field.TOKEN_B]?.symbol}
                  </div>
                </RowBetween>
                <RowBetween>
                  <div />
                  <div>
                    1 {tokens[Field.TOKEN_B]?.symbol} = {route.midPrice.invert().toSignificant(6)}{' '}
                    {tokens[Field.TOKEN_A]?.symbol}
                  </div>
                </RowBetween>
              </div>
            )}
            <div style={{ position: 'relative' }}>
              {!account ? (
                <ButtonLight onClick={toggleWalletModal}>Connect Wallet</ButtonLight>
              ) : (
                <RowBetween>
                  <ButtonConfirmed
                    onClick={onAttemptToApprove}
                    confirmed={approval === ApprovalState.APPROVED || signatureData !== null}
                    disabled={approval !== ApprovalState.NOT_APPROVED || signatureData !== null}
                    mr="0.5rem"
                    fontWeight={500}
                    fontSize={16}
                  >
                    {approval === ApprovalState.PENDING ? (
                      <Dots>Approving</Dots>
                    ) : approval === ApprovalState.APPROVED || signatureData !== null ? (
                      'Approved'
                    ) : (
                      'Approve'
                    )}
                  </ButtonConfirmed>
                  <ButtonError
                    onClick={() => {
                      setShowConfirm(true)
                    }}
                    disabled={!isValid || (signatureData === null && approval !== ApprovalState.APPROVED)}
                    error={!isValid && !!parsedAmounts[Field.TOKEN_A] && !!parsedAmounts[Field.TOKEN_B]}
                  >
                    <Text fontSize={16} fontWeight={500}>
                      {error || 'Remove'}
                    </Text>
                  </ButtonError>
                </RowBetween>
              )}
            </div>
          </AutoColumn>
        </Wrapper>
      </AppBody>

      {pair ? (
        <AutoColumn style={{ minWidth: '20rem', marginTop: '1rem' }}>
          <PositionCard pair={pair} minimal={true} />
        </AutoColumn>
      ) : null}
    </>
  )
}
