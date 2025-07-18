import { Token } from '@AIHISwap/sdk'
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isMobile } from 'react-device-detect'
import { useTranslation } from 'react-i18next'
import { Text } from 'rebass'
import { ThemeContext } from 'styled-components'
import Card from '../../components/Card'
import { useActiveWeb3React } from '../../hooks'
import { useAllTokens, useToken } from '../../hooks/Tokens'
import { useAllTokenBalancesTreatingWETHasETH, useTokenBalanceTreatingWETHasETH } from '../../state/wallet/hooks'
import { CloseIcon, LinkStyledButton } from '../../theme/components'
import { isAddress } from '../../utils'
import Column from '../Column'
import Modal from '../Modal'
import QuestionHelper from '../QuestionHelper'
import { AutoRow, RowBetween } from '../Row'
import Tooltip from '../Tooltip'
import CommonBases from './CommonBases'
import { filterTokens } from './filtering'
import { useTokenComparator } from './sorting'
import { PaddedColumn, SearchInput } from './styleds'
import TokenList from './TokenList'
import SortButton from './SortButton'

interface TokenSearchModalProps {
  isOpen?: boolean
  onDismiss?: () => void
  hiddenToken?: string
  showSendWithSwap?: boolean
  onTokenSelect?: (address: string) => void
  otherSelectedTokenAddress?: string
  otherSelectedText?: string
  showCommonBases?: boolean
}

export default function TokenSearchModal({
  isOpen,
  onDismiss,
  onTokenSelect,
  hiddenToken,
  showSendWithSwap,
  otherSelectedTokenAddress,
  otherSelectedText,
  showCommonBases = false
}: TokenSearchModalProps) {
  const { t } = useTranslation()
  const { account, chainId } = useActiveWeb3React()
  const theme = useContext(ThemeContext)

  const [searchQuery, setSearchQuery] = useState<string>('')
  const [tooltipOpen, setTooltipOpen] = useState<boolean>(false)
  const [invertSearchOrder, setInvertSearchOrder] = useState<boolean>(false)
  const allTokens = useAllTokens()

  // if the current input is an address, and we don't have the token in context, try to fetch it and import
  const searchToken = useToken(searchQuery)
  const searchTokenBalance = useTokenBalanceTreatingWETHasETH(account, searchToken)
  const allTokenBalances_ = useAllTokenBalancesTreatingWETHasETH()
  const allTokenBalances = searchToken
    ? {
        [searchToken.address]: searchTokenBalance
      }
    : allTokenBalances_ ?? {}

  const tokenComparator = useTokenComparator(invertSearchOrder)

  const filteredTokens: Token[] = useMemo(() => {
    if (searchToken) return [searchToken]
    return filterTokens(Object.values(allTokens), searchQuery)
  }, [searchToken, allTokens, searchQuery])

  const filteredSortedTokens: Token[] = useMemo(() => {
    if (searchToken) return [searchToken]
    const sorted = filteredTokens.sort(tokenComparator)
    const symbolMatch = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(s => s.length > 0)
    if (symbolMatch.length > 1) return sorted

    return [
      ...(searchToken ? [searchToken] : []),
      // sort any exact symbol matches first
      ...sorted.filter(token => token.symbol.toLowerCase() === symbolMatch[0]),
      ...sorted.filter(token => token.symbol.toLowerCase() !== symbolMatch[0])
    ]
  }, [filteredTokens, searchQuery, searchToken, tokenComparator])

  const handleTokenSelect = useCallback(
    (address: string) => {
      onTokenSelect(address)
      onDismiss()
    },
    [onDismiss, onTokenSelect]
  )

  // clear the input on open
  useEffect(() => {
    if (isOpen) setSearchQuery('')
  }, [isOpen, setSearchQuery])

  // manage focus on modal show
  const inputRef = useRef<HTMLInputElement>()
  const handleInput = useCallback(event => {
    const input = event.target.value
    const checksummedInput = isAddress(input)
    setSearchQuery(checksummedInput || input)
    setTooltipOpen(false)
  }, [])

  const openTooltip = useCallback(() => {
    setTooltipOpen(true)
    inputRef.current?.focus()
  }, [setTooltipOpen])
  const closeTooltip = useCallback(() => setTooltipOpen(false), [setTooltipOpen])

  return (
    <Modal
      isOpen={isOpen}
      onDismiss={onDismiss}
      maxHeight={70}
      initialFocusRef={isMobile ? undefined : inputRef}
      minHeight={70}
    >
      <Column style={{ width: '100%' }}>
        <PaddedColumn gap="20px">
          <RowBetween>
            <Text fontWeight={500} fontSize={16}>
              Select a token
              <QuestionHelper
                disabled={tooltipOpen}
                text="Find a token by searching for its name or symbol or by pasting its address below."
              />
            </Text>
            <CloseIcon onClick={onDismiss} />
          </RowBetween>
          <Tooltip
            text="Import any token into your list by pasting the token address into the search field."
            show={tooltipOpen}
            placement="bottom"
          >
            <SearchInput
              type="text"
              id="token-search-input"
              placeholder={t('tokenSearchPlaceholder')}
              value={searchQuery}
              ref={inputRef}
              onChange={handleInput}
              onBlur={closeTooltip}
            />
          </Tooltip>
          {showCommonBases && (
            <CommonBases chainId={chainId} onSelect={handleTokenSelect} selectedTokenAddress={hiddenToken} />
          )}
          <RowBetween>
            <Text fontSize={14} fontWeight={500}>
              Token Name
            </Text>
            <SortButton ascending={invertSearchOrder} toggleSortOrder={() => setInvertSearchOrder(iso => !iso)} />
          </RowBetween>
        </PaddedColumn>
        <div style={{ width: '100%', height: '1px', backgroundColor: theme.bg2 }} />
        <TokenList
          tokens={filteredSortedTokens}
          allTokenBalances={allTokenBalances}
          onTokenSelect={handleTokenSelect}
          otherSelectedText={otherSelectedText}
          otherToken={otherSelectedTokenAddress}
          selectedToken={hiddenToken}
          showSendWithSwap={showSendWithSwap}
        />
        <div style={{ width: '100%', height: '1px', backgroundColor: theme.bg2 }} />
        <Card>
          <AutoRow justify={'center'}>
            <div>
              <LinkStyledButton style={{ fontWeight: 500, color: theme.text2, fontSize: 16 }} onClick={openTooltip}>
                Having trouble finding a token?
              </LinkStyledButton>
            </div>
          </AutoRow>
        </Card>
      </Column>
    </Modal>
  )
}
