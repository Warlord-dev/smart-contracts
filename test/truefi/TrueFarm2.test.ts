import { expect, use } from 'chai'
import { parseEther } from '@ethersproject/units'
import { MaxUint256 } from '@ethersproject/constants'
import { Wallet, BigNumber, BigNumberish } from 'ethers'
import { MockProvider, solidity } from 'ethereum-waffle'

import {
  beforeEachWithFixture,
  timeTravel,
  timeTravelTo,
  expectCloseTo,
} from 'utils'

import {
  MockErc20Token,
  MockErc20TokenFactory,
  LinearTrueDistributor,
  TrueFarmFactory,
  TrueFarm,
  LinearTrueDistributorFactory,
} from 'contracts'

use(solidity)

describe('TrueFarm', () => {
  const DAY = 24 * 3600
  let owner: Wallet
  let staker1: Wallet
  let staker2: Wallet
  let distributor: LinearTrueDistributor
  let trustToken: MockErc20Token
  let stakingToken: MockErc20Token
  let provider: MockProvider
  let farm: TrueFarm
  let farm2: TrueFarm
  let start: number
  const REWARD_DAYS = 10
  const DURATION = REWARD_DAYS * DAY
  const amount = BigNumber.from('100000000000') // 1000 TRU = 100/day

  const fromTru = (amount: BigNumberish) => BigNumber.from(amount).mul(BigNumber.from('100000000'))

  beforeEachWithFixture(async (wallets, _provider) => {
    [owner, staker1, staker2] = wallets
    provider = _provider
    trustToken = await new MockErc20TokenFactory(owner).deploy()
    stakingToken = await new MockErc20TokenFactory(owner).deploy()
    distributor = await new LinearTrueDistributorFactory(owner).deploy()
    const now = Math.floor(Date.now() / 1000)
    start = now + DAY

    await distributor.initialize(start, DURATION, amount, trustToken.address)

    farm = await new TrueFarmFactory(owner).deploy()
    farm2 = await new TrueFarmFactory(owner).deploy()

    await distributor.setFarm(farm.address)
    await farm.initialize(stakingToken.address, distributor.address, 'Test farm')

    await trustToken.mint(distributor.address, amount)
    // await distributor.transfer(owner.address, farm.address, amount)
    await stakingToken.mint(staker1.address, parseEther('1000'))
    await stakingToken.mint(staker2.address, parseEther('1000'))
    await stakingToken.connect(staker1).approve(farm.address, MaxUint256)
    await stakingToken.connect(staker2).approve(farm.address, MaxUint256)
  })

  describe('initializer', () => {
    it('name is correct', async () => {
      expect(await farm.name()).to.equal('Test farm')
    })

    it('owner can withdraw funds', async () => {
      await distributor.empty()
      expect(await trustToken.balanceOf(owner.address)).to.equal(amount)
    })

    it('owner can change farm with event', async () => {
      await expect(distributor.setFarm(farm2.address)).to.emit(distributor, 'FarmChanged')
        .withArgs(farm2.address)
    })

    it('cannot init farm unless distributor is set to farm', async () => {
      await expect(farm2.initialize(stakingToken.address, distributor.address, 'Test farm'))
        .to.be.revertedWith('distributor farm not set')
    })
  })

  describe('one staker', () => {
    beforeEach(async () => {
      await timeTravelTo(provider, start)
    })

    it('correct events emitted', async () => {
      const asStaker = await farm.connect(staker1)
      await expect(asStaker.stake(parseEther('500'))).to.emit(farm, 'Stake')
        .withArgs(staker1.address, parseEther('500'))
      await timeTravel(provider, DAY)
      await expect(asStaker.claim()).to.emit(farm, 'Claim')
      await expect(asStaker.unstake(parseEther('500'))).to.emit(farm, 'Unstake')
        .withArgs(staker1.address, parseEther('500'))
    })

    it('staking changes stake balance', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      expect(await farm.staked(staker1.address)).to.equal(parseEther('500'))
      expect(await farm.totalStaked()).to.equal(parseEther('500'))

      await farm.connect(staker1).stake(parseEther('500'))
      expect(await farm.staked(staker1.address)).to.equal(parseEther('1000'))
      expect(await farm.totalStaked()).to.equal(parseEther('1000'))
    })

    it('unstaking changes stake balance', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await farm.connect(staker1).unstake(parseEther('500'))
      expect(await farm.staked(staker1.address)).to.equal(parseEther('500'))
      expect(await farm.totalStaked()).to.equal(parseEther('500'))
    })

    it('exiting changes stake balance', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await farm.connect(staker1).exit(parseEther('500'))
      expect(await farm.staked(staker1.address)).to.equal(parseEther('500'))
      expect(await farm.totalStaked()).to.equal(parseEther('500'))
    })

    it('cannot unstake more than is staked', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await expect(farm.connect(staker1).unstake(parseEther('1001'))).to.be.revertedWith('TrueFarm: Cannot withdraw amount bigger than available balance')
    })

    it('cannot exit more than is staked', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await expect(farm.connect(staker1).exit(parseEther('1001'))).to.be.revertedWith('TrueFarm: Cannot withdraw amount bigger than available balance')
    })

    it('yields rewards per staked tokens (using claim)', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(100)))
    })

    it('yields rewards per staked tokens (using exit)', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).exit(parseEther('1000'))
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(100)))
    })

    it('estimate rewards correctly', async () => {
      await farm.connect(staker1).stake(parseEther('1000'))
      await timeTravel(provider, DAY)
      expect(expectCloseTo((await farm.claimable(staker1.address)), fromTru(100)))
      await timeTravel(provider, DAY)
      expect(expectCloseTo((await farm.claimable(staker1.address)), fromTru(200)))
      await farm.connect(staker1).unstake('100')
      expect(expectCloseTo((await farm.claimable(staker1.address)), fromTru(200)))
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(200)))
    })

    it('rewards when stake increases', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()

      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(200)))
    })

    it('sending stake tokens to TrueFarm does not affect calculations', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await stakingToken.connect(staker1).transfer(farm.address, parseEther('500'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()

      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(100)))
    })

    it('claiming clears claimableRewards', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).stake(parseEther('500'))
      expect(await farm.claimableReward(staker1.address)).to.be.gt(0)

      await farm.connect(staker1).claim()
      expect(await farm.claimableReward(staker1.address)).to.equal(0)
      expect(await farm.claimable(staker1.address)).to.equal(0)
    })

    it('calling distribute does not break reward calculations', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY)
      await distributor.distribute()
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(200)))
    })

    it('splitting distributor shares does not break reward calculations', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY)
      // await distributor.transfer(farm.address, owner.address, (await distributor.TOTAL_SHARES()).div(2))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(200)))
    })

    it('owner withdrawing distributes funds', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(0)))
      await timeTravel(provider, DAY)
      await distributor.connect(owner).empty()
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(100)))
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(100)))
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(0)))
    })

    it('changing farm distributes funds', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(0)))
      await timeTravel(provider, DAY)
      await distributor.connect(owner).setFarm(farm2.address)
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(100)))
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), fromTru(100)))
      expect(expectCloseTo((await trustToken.balanceOf(farm.address)), fromTru(0)))
    })

    it('can withdraw liquidity after all TRU is distributed', async () => {
      await farm.connect(staker1).stake(parseEther('500'))
      await timeTravel(provider, DAY * REWARD_DAYS)
      await farm.connect(staker1).claim()
      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), amount))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).unstake('500')
    })
  })

  describe('with two stakers', function () {
    const dailyReward = amount.div(REWARD_DAYS)

    beforeEach(async () => {
      // staker1 with 4/5 of stake
      await farm.connect(staker1).stake(parseEther('400'))
      // staker 2 has 1/5 of stake
      await farm.connect(staker2).stake(parseEther('100'))
      await timeTravelTo(provider, start)
    })

    it('earn rewards in proportion to stake share', async () => {
      const days = 1
      await timeTravel(provider, DAY * days)
      await farm.connect(staker1).claim()
      await farm.connect(staker2).claim()

      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)),
        dailyReward.mul(days).mul(4).div(5)))
      expect(expectCloseTo((await trustToken.balanceOf(staker2.address)),
        dailyReward.mul(days).mul(1).div(5)))
    })

    it('if additional funds are transferred to farm, they are also distributed accordingly to shares', async () => {
      const days = 1
      const additionalReward = fromTru(100)
      const totalReward = dailyReward.add(additionalReward)
      await timeTravel(provider, DAY * days)
      trustToken.mint(farm.address, additionalReward)
      await farm.connect(staker1).claim()
      await farm.connect(staker2).claim()

      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)),
        totalReward.mul(days).mul(4).div(5)))
      expect(expectCloseTo((await trustToken.balanceOf(staker2.address)),
        totalReward.mul(days).mul(1).div(5)))
    })

    it('handles reward calculation after unstaking', async () => {
      const days = 1
      await timeTravel(provider, DAY)
      await farm.connect(staker1).unstake(parseEther('300'))
      await timeTravel(provider, DAY)
      await farm.connect(staker1).claim()
      await farm.connect(staker2).claim()

      const staker1Reward = dailyReward.mul(days).mul(4).div(5).add(
        dailyReward.mul(days).mul(1).div(2))
      const staker2Reward = dailyReward.mul(days).mul(1).div(5).add(
        dailyReward.mul(days).mul(1).div(2))

      expect(expectCloseTo((await trustToken.balanceOf(staker1.address)), staker1Reward))
      expect(expectCloseTo((await trustToken.balanceOf(staker2.address)), staker2Reward))
    })
  })
})