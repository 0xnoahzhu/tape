import { describe, expect, it } from 'vitest';
import { index, stock } from '@shared/contract';
import type { ContractRef, SymbolMatch } from '@shared/types';
import { isExactSymbol, isUsListing, listingTag, matchTier, priceUnit, rankMatches, splitReceipt } from './listing';

/** A search result as main maps IB's symbolSamples (ranking and tags go by the primary exchange, not the route). */
const stk = (symbol: string, primaryExchange: string, currency: string, conId: number, description: string): SymbolMatch => ({
  contract: { symbol, secType: 'STK', exchange: 'SMART', primaryExchange, currency, conId },
  description,
  derivativeSecTypes: [],
});
const ind = (symbol: string, exchange: string, currency: string, conId: number, description: string): SymbolMatch => ({
  contract: { symbol, secType: 'IND', exchange, currency, conId },
  description,
  derivativeSecTypes: [],
});
const rows = (out: SymbolMatch[]) => out.map((m) => `${m.contract.symbol}@${m.contract.primaryExchange ?? m.contract.exchange}:${m.contract.currency}`);

// What IB returned for "AAPL" (paper account, October 2026), in IB's order.
const AAPL = [
  stk('AAPL', 'NASDAQ', 'USD', 265598, 'APPLE INC'),
  stk('AAPL', 'MEXI', 'MXN', 38708077, 'APPLE INC'),
  stk('AAPL', 'EBS', 'CHF', 273982664, 'APPLE INC'),
  stk('AAPL', 'TSE', 'CAD', 532640894, 'APPLE INC-CDR'),
  stk('AAPLUSD', 'EBS', 'USD', 242506861, 'APPLE INC'),
  stk('AAPU', 'NASDAQ', 'USD', 578561419, 'DIREXION DAILY AAPL BULL 2X'),
  stk('APLY', 'ARCA', 'USD', 625840793, 'YIELDMAX AAPL OPTION INCOME'),
  stk('AAPW', 'BATS', 'USD', 762285103, 'ROUNDHILL AAPL WEEKLYPAY ETF'),
  stk('AAPD', 'NASDAQ', 'USD', 578561422, 'DIREXION DAILY AAPL BEAR 1X'),
  stk('AAPB', 'NASDAQ', 'USD', 578561458, 'GRANITESHARES 2X LONG AAPL D'),
  stk('AAPY', 'BATS', 'USD', 742759295, 'KURV YLD PREM STR AAPL ETF'),
  stk('AAPU', 'TSE', 'CAD', 789278751, 'SAVVYLONG 2X AAPL ETF'),
  ind('AVSPY', 'NASDAQ', 'USD', 86792725, 'Nasdaq OMX Alpha AAPL vs. SPY Index'),
];

const BRK = [
  stk('BRK', 'TSE', 'CAD', 530091924, 'BERKSHIRE HATHAWAY INC-CDR'),
  stk('BRK', 'LSE', 'GBP', 89552268, 'BROOKS MACDONALD GROUP PLC'),
  stk('BRK', 'ASX', 'AUD', 198013455, 'BROOKSIDE ENERGY LTD'),
  stk('BRK', 'BVB', 'RON', 813325505, 'SSIF BRK FINANCIAL GROUP SA'),
  stk('BRK B', 'NYSE', 'USD', 72063691, 'BERKSHIRE HATHAWAY INC-CL B'),
  stk('BRK A', 'NYSE', 'USD', 5222, 'BERKSHIRE HATHAWAY INC-CL A'),
  stk('BRKR', 'NASDAQ', 'USD', 9905742, 'BRUKER CORP'),
  stk('BRKN', 'EBS', 'CHF', 128527581, 'BURKHALTER HOLDING AG'),
  stk('BRKB', 'MEXI', 'MXN', 501785781, 'BERKSHIRE HATHAWAY INC-CL B'),
  stk('BRK BUSD', 'EBS', 'USD', 835599867, 'BERKSHIRE HATHAWAY INC-CL B'),
  stk('BRKW', 'BATS', 'USD', 792065898, 'ROUNDHILL BRKB WEEKLYPAY ETF'),
  stk('ETEC', 'NASDAQ', 'USD', 622498037, 'ISHARES BRKTHR ENVIR SOL ETF'),
  stk('BRKD.OLD', 'VALUE', 'USD', 747568706, 'DIREXION DAILY BRKB BEAR 1X'),
];

const BABA = [
  stk('BABA', 'NYSE', 'USD', 166090175, 'ALIBABA GROUP HOLDING-SP ADR'),
  stk('BABA', 'BURSAMY', 'MYR', 705926008, 'BABA ECO GROUP SDN BHD'),
  stk('BABA', 'EBS', 'CHF', 305691283, 'ALIBABA GROUP HOLDING-SP ADR'),
  stk('BABAN', 'MEXI', 'MXN', 435742387, 'ALIBABA GROUP HOLDING-SP ADR'),
  stk('BABA.TEN', 'CORPACT', 'USD', 396138110, 'ALIBABA GROUP HOLDING-SP ADR - TENDER'),
  stk('BABA.CNV', 'CORPACT', 'USD', 749047298, 'ALIBABA GROUP HOLDING-SP ADR - CONVERSION'),
  stk('BABX', 'NASDAQ', 'USD', 602261429, 'GRANITESH 2XLNG BABA ETF-USD'),
  stk('BABO', 'ARCA', 'USD', 721315273, 'YIELDMAX BABA OPT INC ST ETF'),
];

describe('listings', () => {
  it('tells US listings from foreign ones', () => {
    expect(isUsListing(AAPL[0].contract)).toBe(true);
    expect(isUsListing(AAPL[1].contract)).toBe(false);
    // A USD line on a foreign exchange is foreign.
    expect(isUsListing(AAPL[4].contract)).toBe(false);
    expect(isUsListing(stock('ZZZ'))).toBe(true);
    expect(isUsListing(index('SPX', 'CBOE'))).toBe(true);
    expect(isUsListing({ symbol: 'BTC', secType: 'CRYPTO', exchange: 'PAXOS', currency: 'USD' })).toBe(true);
    expect(isUsListing({ symbol: 'SPXEU', secType: 'IND', exchange: 'IBIS', currency: 'USD' })).toBe(false);
    // The built-in Russell 2000 and US Dollar indices, and US OTC stocks.
    expect(isUsListing(index('RUT', 'RUSSELL'))).toBe(true);
    expect(isUsListing(index('DX', 'NYBOT'))).toBe(true);
    expect(isUsListing(stk('VODG', 'DOLLR4LOT', 'USD', 30218095, 'VITRO DIAGNOSTICS INC').contract)).toBe(true);
  });

  it('matches the symbol and its share classes', () => {
    expect(isExactSymbol(stock('BRK B'), 'BRK')).toBe(true);
    expect(isExactSymbol(stock('BRK B'), 'brk.b')).toBe(true);
    expect(isExactSymbol(stock('BRK BUSD'), 'BRK')).toBe(false);
    expect(isExactSymbol(stock('BRKR'), 'BRK')).toBe(false);
    expect(isExactSymbol(index('SPY.IV', 'PSE'), 'SPY')).toBe(false);
    expect(matchTier(stock('BRK B', 'NYSE'), 'BRK')).toBe(0);
    expect(matchTier(stock('BRKR', 'NASDAQ'), 'BRK')).toBe(1);
    expect(matchTier(stock('ETEC', 'NASDAQ'), 'BRK')).toBe(2);
    expect(matchTier({ ...stock('BRK', 'TSE'), currency: 'CAD' }, 'BRK')).toBe(3);
    expect(matchTier({ ...stock('BRKN', 'EBS'), currency: 'CHF' }, 'BRK')).toBe(4);
    // An index named as searched leads when it is a US index; a foreign one is a foreign listing.
    expect(matchTier(index('SPX', 'CBOE'), 'spx')).toBe(0);
    expect(matchTier({ symbol: 'DAX', secType: 'IND', exchange: 'EUREX', currency: 'EUR' }, 'dax')).toBe(3);
    expect(matchTier({ symbol: 'RY', secType: 'IND', exchange: 'CME', currency: 'EUR' }, 'RY')).toBe(3);
  });

  it('ranks the US listing first and keeps two foreign listings of the symbol', () => {
    expect(rows(rankMatches(AAPL, 'AAPL', 8))).toEqual([
      'AAPL@NASDAQ:USD',
      'AAPU@NASDAQ:USD',
      'APLY@ARCA:USD',
      'AAPW@BATS:USD',
      'AAPD@NASDAQ:USD',
      'AAPB@NASDAQ:USD',
      'AAPL@MEXI:MXN',
      'AAPL@EBS:CHF',
    ]);
    // Without a row limit: every US row, then at most two foreign ones.
    const all = rankMatches(AAPL, 'aapl');
    expect(all.filter((m) => !isUsListing(m.contract))).toHaveLength(2);
    expect(all.map((m) => m.contract.symbol).slice(0, 9)).toEqual(['AAPL', 'AAPU', 'APLY', 'AAPW', 'AAPD', 'AAPB', 'AAPY', 'AVSPY', 'AAPL']);
  });

  it('puts share classes first and drops delisted lines', () => {
    expect(rows(rankMatches(BRK, 'BRK', 8))).toEqual([
      'BRK B@NYSE:USD',
      'BRK A@NYSE:USD',
      'BRKR@NASDAQ:USD',
      'BRKW@BATS:USD',
      'ETEC@NASDAQ:USD',
      'BRK@TSE:CAD',
      'BRK@LSE:GBP',
    ]);
  });

  it('drops corporate-action lines', () => {
    expect(rows(rankMatches(BABA, 'BABA', 8))).toEqual(['BABA@NYSE:USD', 'BABX@NASDAQ:USD', 'BABO@ARCA:USD', 'BABA@BURSAMY:MYR', 'BABA@EBS:CHF']);
  });

  it('keeps foreign listings when there is no US listing', () => {
    const toyota = [stk('7203', 'TSEJ', 'JPY', 1, 'TOYOTA MOTOR CORP'), stk('TOM', 'IBIS', 'EUR', 2, 'TOYOTA MOTOR CORP'), stk('TYT', 'LSE', 'GBP', 3, 'TOYOTA MOTOR CORP')];
    expect(rankMatches(toyota, 'TOYOTA', 8)).toHaveLength(3);
  });

  it('dedupes by conId, by listing and by quote key', () => {
    const a = AAPL[0];
    const sameConId = { ...a, contract: { ...a.contract, primaryExchange: 'NASDAQ.NMS' } };
    const sameListing = { ...a, contract: { ...a.contract, conId: undefined } };
    const sameKey = stk('AAPL', 'LSEETF', 'USD', 99, 'LS 1X AAPL');
    expect(rankMatches([sameKey, a, sameConId, sameListing], 'AAPL')).toEqual([a]);
  });

  it('cuts US rows before exact foreign listings when the list is full', () => {
    const us = Array.from({ length: 10 }, (_, i) => stk(`AAP${i}`, 'NASDAQ', 'USD', 100 + i, `Fund ${i}`));
    const out = rankMatches([...us, AAPL[1], AAPL[0]], 'AAPL', 6);
    expect(out.map((m) => m.contract.symbol)).toEqual(['AAPL', 'AAP0', 'AAP1', 'AAP2', 'AAP3', 'AAPL']);
    // Foreign listings of other symbols get no reserved row.
    const other = rankMatches([...us, AAPL[11]], 'AAPL', 6);
    expect(other.every((m) => isUsListing(m.contract))).toBe(true);
  });

  it('ranks indices like listings: a US index named as searched leads, a foreign one follows the US rows', () => {
    const dax = [
      ind('DAX', 'EUREX', 'EUR', 825711, 'DAX 40 Index (Deutsche Aktien Xchange 40)'),
      stk('DAX', 'NASDAQ', 'USD', 346727821, 'GLOBAL X DAX GERMANY ETF'),
      stk('DAXX', 'LSE', 'GBP', 165198494, 'AMUNDI DAX II UCITS ETF ACC'),
    ];
    expect(rows(rankMatches(dax, 'DAX', 8))).toEqual(['DAX@NASDAQ:USD', 'DAX@EUREX:EUR', 'DAXX@LSE:GBP']);
    // What IB returned for "RY": the EUR/JPY cross rate index on CME no longer comes second.
    const ry = [
      stk('RY', 'TSE', 'CAD', 4458964, 'ROYAL BANK OF CANADA'),
      stk('RY', 'NYSE', 'USD', 2008980, 'ROYAL BANK OF CANADA'),
      ind('RY', 'CME', 'EUR', 16866357, 'Euro FX/ Japanese Yen Cross Rate'),
      stk('RYCEY', 'PINK', 'USD', 65134067, 'ROLLS-ROYCE HOLDINGS-SP ADR'),
      stk('RYAAY', 'NASDAQ', 'USD', 210918190, 'RYANAIR HOLDINGS PLC-SP ADR'),
      stk('RYA', 'ISED', 'EUR', 208908706, 'RYANAIR HOLDINGS PLC'),
      stk('RYTM', 'NASDAQ', 'USD', 291378079, 'RHYTHM PHARMACEUTICALS INC'),
      stk('RYN', 'NYSE', 'USD', 11800, 'RAYONIER INC'),
      stk('RYAN', 'NYSE', 'USD', 503836700, 'RYAN SPECIALTY HOLDINGS INC'),
      stk('RYZ', 'NYSE', 'USD', 162868722, 'RYERSON HOLDING CORP'),
      stk('RYLD', 'ARCA', 'USD', 361439195, 'GLOBAL X RUSSELL 2000 COV CL'),
    ];
    expect(rows(rankMatches(ry, 'RY', 8))).toEqual([
      'RY@NYSE:USD',
      'RYCEY@PINK:USD',
      'RYAAY@NASDAQ:USD',
      'RYTM@NASDAQ:USD',
      'RYN@NYSE:USD',
      'RYAN@NYSE:USD',
      'RY@TSE:CAD',
      'RY@CME:EUR',
    ]);
    const spx = [stk('SPX', 'LSE', 'GBP', 196961203, 'SPIRAX GROUP PLC'), ind('SPX', 'CBOE', 'USD', 416904, 'S&P 500 Stock Index'), stk('SPXL', 'ARCA', 'USD', 55679428, 'DIREXION DAILY S&P 500 BULL')];
    expect(rows(rankMatches(spx, 'SPX', 8))).toEqual(['SPX@CBOE:USD', 'SPXL@ARCA:USD', 'SPX@LSE:GBP']);
  });

  it('finds the Russell indices by name and the built-in indices offline', () => {
    // What IB returned for "russell", in IB's order (RUT first).
    const russell = [
      ind('RUT', 'RUSSELL', 'USD', 416888, 'Russell 2000 Stock Index'),
      ind('RTY', 'CME', 'USD', 24771018, 'E-mini Russell 2000 Index'),
      ind('RLV', 'RUSSELL', 'USD', 18073411, 'Russell 1000 Value Index'),
      ind('RSV', 'CME', 'USD', 325536308, 'E-Mini Russell 1000 Value Index Futures'),
      stk('IWF', 'ARCA', 'USD', 8991557, 'ISHARES RUSSELL 1000 GROWTH'),
      stk('IRU', 'VALUE', 'AUD', 47200084, 'ISHARES RUSSELL 2000-CDI'),
      ind('RYO', 'NYBOT', 'USD', 45629392, 'Russell 1000 Index'),
    ];
    expect(rows(rankMatches(russell, 'russell', 8))).toEqual(['RUT@RUSSELL:USD', 'RTY@CME:USD', 'RLV@RUSSELL:USD', 'RSV@CME:USD', 'IWF@ARCA:USD', 'RYO@NYBOT:USD']);
    // Watchlist entries matching "R" while IB search is unavailable (MSFT, TNX by name).
    const offline = [stock('MSFT', 'NASDAQ'), index('TNX', 'CBOE'), index('RUT', 'RUSSELL'), index('DX', 'NYBOT')].map((contract) => ({ contract, description: '', derivativeSecTypes: [] }));
    expect(rankMatches(offline, 'R', 8).map((m) => m.contract.symbol)).toEqual(['RUT', 'MSFT', 'TNX', 'DX']);
  });

  it('tags each listing', () => {
    const tag = (c: ContractRef) => listingTag(c, 'Index');
    expect(AAPL.slice(0, 5).map((m) => tag(m.contract))).toEqual(['NASDAQ', 'MEXI · MXN', 'EBS · CHF', 'TSE · CAD', 'EBS · USD']);
    expect(tag(index('SPX', 'CBOE'))).toBe('Index');
    expect(listingTag({ symbol: 'DAX', secType: 'IND', exchange: 'EUREX', currency: 'EUR' }, '指数')).toBe('指数 · EUR');
    expect(tag({ symbol: 'BTC', secType: 'CRYPTO', exchange: 'PAXOS', currency: 'USD' })).toBe('PAXOS');
    expect(tag(stock('ZZZ'))).toBe('');
    expect(tag({ symbol: 'SAP', secType: 'STK', exchange: 'SMART', currency: 'EUR' })).toBe('EUR');
  });

  it('gives a price in another currency its unit, pence as pence', () => {
    expect(priceUnit(AAPL[0].contract)).toBeUndefined();
    expect(priceUnit(AAPL[1].contract)).toBe('MXN');
    expect(priceUnit(AAPL[2].contract, 1)).toBe('CHF');
    // Index points are not an amount of money.
    expect(priceUnit({ symbol: 'DAX', secType: 'IND', exchange: 'EUREX', currency: 'EUR' })).toBeUndefined();
    // LSE, JSE and TASE stocks are quoted in pence, cents and agorot (IB: priceMagnifier 100).
    expect(priceUnit(BRK[1].contract)).toBe('GBp');
    expect(priceUnit(stk('VOD', 'JSE', 'ZAR', 290088199, 'VODACOM GROUP LTD').contract)).toBe('ZAc');
    expect(priceUnit(stk('BIG', 'TASE', 'ILS', 1, 'BIG SHOPPING CENTERS').contract)).toBe('ILA');
    // On LSEETF it depends on the fund: nothing until the contract details tell.
    const gbpEtf = stk('XDAX', 'LSEETF', 'GBP', 290085870, 'X DAX 1C').contract;
    expect(priceUnit(gbpEtf)).toBeUndefined();
    expect(priceUnit(gbpEtf, 100)).toBe('GBp');
    expect(priceUnit(stk('SPX5', 'LSEETF', 'GBP', 104790439, 'SS SPDR S&P 500 UCIT ETF-UHG').contract, 1)).toBe('GBP');
    expect(priceUnit(stk('3LME', 'LSEETF', 'EUR', 647805794, 'GRANITESHARES 3X LONG MSFT').contract)).toBe('EUR');
    // A minor unit Tape has no name for is left out rather than mislabelled.
    expect(priceUnit(stk('X', 'KSE', 'KWD', 1, 'X').contract, 1000)).toBeUndefined();
  });

  it('splits depositary receipt suffixes off names', () => {
    expect(splitReceipt('APPLE INC-CDR')).toEqual({ base: 'APPLE INC', suffix: '-CDR' });
    expect(splitReceipt('TESLA INC - CDR')).toEqual({ base: 'TESLA INC', suffix: ' - CDR' });
    expect(splitReceipt('ALIBABA GROUP HOLDING-SP ADR')).toEqual({ base: 'ALIBABA GROUP HOLDING', suffix: '-SP ADR' });
    expect(splitReceipt('NOVO-NORDISK A/S-SPONS ADR')).toEqual({ base: 'NOVO-NORDISK A/S', suffix: '-SPONS ADR' });
    expect(splitReceipt('TENCENT HOLDINGS LTD-UNS ADR')).toEqual({ base: 'TENCENT HOLDINGS LTD', suffix: '-UNS ADR' });
    expect(splitReceipt('TENCENT HOLDINGS LTD-SDR')).toEqual({ base: 'TENCENT HOLDINGS LTD', suffix: '-SDR' });
    expect(splitReceipt('BERKSHIRE HATHAWAY INC-CL B')).toEqual({ base: 'BERKSHIRE HATHAWAY INC-CL B', suffix: '' });
    expect(splitReceipt('CADRE HOLDINGS INC')).toEqual({ base: 'CADRE HOLDINGS INC', suffix: '' });
    expect(splitReceipt('CDR')).toEqual({ base: 'CDR', suffix: '' });
  });
});
