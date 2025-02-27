import { AnchorProvider } from '@coral-xyz/anchor'
import { PayloadAction, createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import { Cluster, PublicKey } from '@solana/web3.js'
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import { CSAccount } from '../../storage/cloudStorage'
import { getBalanceHistory, getTokenPrices } from '../../utils/walletApiV2'
import { AccountBalance, Prices, TokenAccount } from '../../types/balance'
import { getEscrowTokenAccount } from '../../utils/solanaUtils'

type BalanceHistoryByCurrency = Record<string, AccountBalance[]>
type BalanceHistoryByWallet = Record<string, BalanceHistoryByCurrency>
type BalanceHistoryByCluster = Record<Cluster, BalanceHistoryByWallet>

export type Tokens = {
  atas: TokenAccount[]
  sol: { tokenAccount: string; balance: number }
  dcEscrow: { tokenAccount: string; balance: number }
}

type AtaBalances = Record<Cluster, Record<string, Tokens>>

export type BalancesState = {
  balancesLoading?: boolean
  tokenPrices?: Prices
  balanceHistory: BalanceHistoryByCluster
  balances: AtaBalances
}

const initialState: BalancesState = {
  balances: {
    'mainnet-beta': {},
    devnet: {},
    testnet: {},
  },
  balanceHistory: {
    'mainnet-beta': {},
    devnet: {},
    testnet: {},
  },
}

export const syncTokenAccounts = createAsyncThunk(
  'balances/syncTokenAccounts',
  async ({
    cluster: _cluster,
    acct,
    anchorProvider,
  }: {
    cluster: Cluster
    acct: CSAccount
    anchorProvider: AnchorProvider
  }): Promise<Tokens> => {
    if (!acct?.solanaAddress) throw new Error('No solana account found')

    const pubKey = new PublicKey(acct.solanaAddress)
    const { connection } = anchorProvider

    const tokenAccounts = await connection.getTokenAccountsByOwner(pubKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    const atas = tokenAccounts.value.map((tokenAccount) => {
      const accountData = AccountLayout.decode(tokenAccount.account.data)
      const { mint } = accountData

      return {
        tokenAccount: tokenAccount.pubkey.toBase58(),
        mint: mint.toBase58(),
        balance: Number(accountData.amount || 0),
      }
    })

    const escrowAccount = getEscrowTokenAccount(acct.solanaAddress)
    let escrowBalance = 0
    const [dcEscrowAcc, solAcc] = await Promise.all([
      connection.getAccountInfo(escrowAccount),
      connection.getAccountInfo(pubKey),
    ])
    try {
      const dcEscrowBalance =
        dcEscrowAcc && AccountLayout.decode(dcEscrowAcc.data).amount
      escrowBalance = dcEscrowBalance
        ? new BN(dcEscrowBalance.toString()).toNumber()
        : 0
    } catch {}

    const dcEscrow = {
      tokenAccount: escrowAccount.toBase58(),
      balance: escrowBalance,
    }

    const solBalance = solAcc?.lamports || 0
    const sol = {
      tokenAccount: acct.solanaAddress,
      balance: solBalance,
    }

    return {
      atas,
      dcEscrow,
      sol,
    }
  },
)

export const readTokenPrices = createAsyncThunk(
  'balances/readTokenPrices',
  async ({ currency }: { currency: string }) => {
    return getTokenPrices(currency)
  },
)

export const readBalanceHistory = createAsyncThunk(
  'balances/readBalanceHistory ',
  async ({
    currency,
    cluster,
    solanaAddress,
  }: {
    currency: string
    cluster: Cluster
    solanaAddress: string
  }) => {
    return getBalanceHistory({
      currency,
      solanaAddress,
      cluster,
    })
  },
)

const balancesSlice = createSlice({
  name: 'balances',
  initialState,
  reducers: {
    updateBalance: (
      state,
      action: PayloadAction<{
        cluster: Cluster
        solanaAddress: string
        balance: number
        type: 'dcEscrow' | 'sol'
        tokenAccount: string
      }>,
    ) => {
      const { payload } = action
      const { cluster, solanaAddress, balance, type, tokenAccount } = payload
      const next = { tokenAccount, balance }
      const prevTokens = state.balances?.[cluster]?.[solanaAddress]
      if (!prevTokens) return

      switch (type) {
        case 'dcEscrow':
          prevTokens.dcEscrow = next
          break
        case 'sol':
          prevTokens.sol = next
          break
      }
    },
    updateAtaBalance: (
      state,
      action: PayloadAction<{
        cluster: Cluster
        solanaAddress: string
        balance: number
        mint: string
        tokenAccount: string
      }>,
    ) => {
      const { payload } = action
      const { cluster, solanaAddress, balance } = payload
      const prevAtas = state.balances?.[cluster]?.[solanaAddress]?.atas || []
      const foundIndex = prevAtas.findIndex(
        ({ tokenAccount, mint }) =>
          tokenAccount === payload.tokenAccount && mint === payload.mint,
      )
      if (foundIndex !== -1) {
        const prev = prevAtas[foundIndex]
        prev.balance = balance
      }
    },
  },
  extraReducers: (builder) => {
    builder.addCase(syncTokenAccounts.pending, (state) => {
      state.balancesLoading = true
    })
    builder.addCase(syncTokenAccounts.fulfilled, (state, action) => {
      const args = action.meta.arg
      const { payload } = action
      if (!args?.acct.solanaAddress || !args.cluster) return state
      const { solanaAddress } = args.acct
      const { cluster } = args
      state.balancesLoading = false

      state.balances[cluster][solanaAddress] = payload
    })
    builder.addCase(syncTokenAccounts.rejected, (state) => {
      state.balancesLoading = false
    })
    builder.addCase(readTokenPrices.fulfilled, (state, action) => {
      const { currency } = action.meta.arg
      if (!state.tokenPrices) {
        state.tokenPrices = {
          helium: {},
          solana: {},
          'helium-iot': {},
          'helium-mobile': {},
        } as Prices
      }
      state.tokenPrices.helium[currency] = action.payload.helium[currency]
      state.tokenPrices['helium-mobile'][currency] =
        action.payload['helium-mobile'][currency]
      state.tokenPrices['helium-iot'][currency] =
        action.payload['helium-iot'][currency]
      state.tokenPrices.solana[currency] = action.payload.solana[currency]
    })
    builder.addCase(readBalanceHistory.fulfilled, (state, action) => {
      const { cluster, solanaAddress: address, currency } = action.meta.arg
      const { payload } = action

      if (!state.balanceHistory[cluster][address]) {
        state.balanceHistory[cluster][address] = {}
      }

      state.balanceHistory[cluster][address][currency] = payload
    })
  },
})

const { reducer, name } = balancesSlice
export { name, balancesSlice }
export default reducer
