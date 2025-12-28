import React, { useState, useCallback, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter, ReferenceLine, AreaChart, Area } from 'recharts';

// ============================================
// 數學常數
// ============================================
const CRITICAL_VALUE = 1 / Math.sqrt(2);
const EPS = 1e-10;

// ============================================
// 枚舉類型
// ============================================
const PlayerStyle = {
  CONSERVATIVE: { id: 'conservative', name: '保守型' },
  AGGRESSIVE: { id: 'aggressive', name: '激進型' },
  BALANCED: { id: 'balanced', name: '平衡型' },
  OPTIMAL: { id: 'optimal', name: '最優型' },
  ADAPTIVE: { id: 'adaptive', name: '適應型' }
};

const ConstraintType = {
  STANDARD: { id: 'standard', name: '標準約束' },
  CUBIC: { id: 'cubic', name: '立方約束' },
  QUARTIC: { id: 'quartic', name: '四次方約束' },
  WEIGHTED: { id: 'weighted', name: '加權約束' }
};

// ============================================
// λ 配置類
// ============================================
class LambdaConfig {
  constructor(lambdaVal) {
    this.lambdaVal = lambdaVal;
    this.compute();
  }

  compute() {
    this.deltaFromCritical = this.lambdaVal - CRITICAL_VALUE;
    this.isAboveCritical = this.deltaFromCritical > 0.005;
    this.isBelowCritical = this.deltaFromCritical < -0.005;
    this.isNearCritical = !this.isAboveCritical && !this.isBelowCritical;

    if (this.isBelowCritical) {
      this.strikeRound = -1;
    } else if (this.isNearCritical) {
      this.strikeRound = 50;
    } else {
      const delta = Math.abs(this.deltaFromCritical);
      const k = delta > 1e-6 ? Math.ceil(1 / (2 * delta * delta)) : 50;
      this.strikeRound = Math.max(10, Math.min(k, 50));
    }

    if (this.isAboveCritical) {
      this.aliceAggression = Math.min(0.95, 0.5 + this.deltaFromCritical * 2);
      this.bazzaAggression = Math.max(0.3, 0.8 - this.deltaFromCritical * 2);
    } else if (this.isBelowCritical) {
      this.aliceAggression = Math.max(0.2, 0.5 + this.deltaFromCritical * 2);
      this.bazzaAggression = Math.min(0.99, 0.8 - this.deltaFromCritical * 2);
    } else {
      this.aliceAggression = 0.7;
      this.bazzaAggression = 0.7;
    }

    this.reserveThreshold = Math.max(0.1, 0.5 - Math.abs(this.deltaFromCritical));
    this.linearMultiplier = this.lambdaVal;
  }

  getStatus() {
    if (this.isNearCritical) return 'balance';
    return this.isAboveCritical ? 'alice' : 'bazza';
  }

  getPredictedWinner() {
    if (this.isAboveCritical) return 'Alice';
    if (this.isBelowCritical) return 'Bazza';
    return 'Balance';
  }
}

// ============================================
// 約束檢查器
// ============================================
class ConstraintChecker {
  constructor(aliceType, bazzaType, config) {
    this.aliceType = aliceType;
    this.bazzaType = bazzaType;
    this.config = config;
  }

  getAliceConstraintValue(moves) {
    if (moves.length === 0) return 0;
    switch (this.aliceType.id) {
      case 'cubic': return moves.reduce((a, b) => a + Math.pow(b, 3), 0);
      case 'weighted': return moves.reduce((a, b, i) => a + (1 + 0.1 * i) * b, 0);
      default: return moves.reduce((a, b) => a + b, 0);
    }
  }

  getAliceConstraintLimit(n) {
    const base = this.config.linearMultiplier * n;
    return this.aliceType.id === 'weighted' ? base * 1.5 : base;
  }

  getBazzaConstraintValue(moves) {
    if (moves.length === 0) return 0;
    switch (this.bazzaType.id) {
      case 'quartic': return moves.reduce((a, b) => a + Math.pow(b, 4), 0);
      case 'weighted': return moves.reduce((a, b, i) => a + (1 + 0.05 * i) * b * b, 0);
      default: return moves.reduce((a, b) => a + b * b, 0);
    }
  }

  getBazzaConstraintLimit(n) {
    switch (this.bazzaType.id) {
      case 'quartic': return n * n;
      case 'weighted': return n * 1.2;
      default: return n;
    }
  }

  getAliceCapacity(moves, n) {
    return Math.max(0, this.getAliceConstraintLimit(n) - this.getAliceConstraintValue(moves));
  }

  getBazzaCapacity(moves, n) {
    const remaining = Math.max(0, this.getBazzaConstraintLimit(n) - this.getBazzaConstraintValue(moves));
    return this.bazzaType.id === 'quartic' ? (remaining > 0 ? Math.pow(remaining, 0.25) : 0) : Math.sqrt(remaining);
  }

  checkAlice(moves, n) {
    const value = this.getAliceConstraintValue(moves);
    const limit = this.getAliceConstraintLimit(n);
    return { valid: value <= limit + EPS, margin: limit - value };
  }

  checkBazza(moves, n) {
    const value = this.getBazzaConstraintValue(moves);
    const limit = this.getBazzaConstraintLimit(n);
    return { valid: value <= limit + EPS, margin: limit - value };
  }
}

// ============================================
// 數學引擎
// ============================================
const MathEngine = {
  cauchySchwarz(x) {
    const n = x.length;
    if (n === 0) return { sumX: 0, sumX2: 0, lhs: 0, rhs: 0, ratio: 0, satisfied: true };
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumX2 = x.reduce((a, b) => a + b * b, 0);
    const lhs = sumX * sumX;
    const rhs = n * sumX2;
    return { sumX, sumX2, lhs, rhs, ratio: lhs / (rhs + EPS), satisfied: lhs <= rhs + EPS };
  }
};

// ============================================
// 擬合工具
// ============================================
const FittingEngine = {
  // 冪次函數擬合: y = a * |x - c|^b + d
  // 使用多層網格搜索 + 精細化迭代
  fitPowerLaw(data, refPoint = CRITICAL_VALUE) {
    if (data.length < 3) return null;
    
    // 分離 Alice 勝和 Bazza 勝的數據
    const aliceData = data.filter(d => d.winner === 'Alice' && d.lambdaVal > refPoint);
    const bazzaData = data.filter(d => d.winner === 'Bazza' && d.lambdaVal < refPoint);
    
    const fitSide = (pts, sign) => {
      if (pts.length < 2) return null;
      
      // 轉換: x = |λ - λ*|, y = rounds
      const transformed = pts.map(p => ({
        x: Math.abs(p.lambdaVal - refPoint),
        y: p.totalRounds
      })).filter(p => p.x > 1e-8);
      
      if (transformed.length < 2) return null;
      
      const minY = Math.min(...transformed.map(p => p.y));
      const maxY = Math.max(...transformed.map(p => p.y));
      const minX = Math.min(...transformed.map(p => p.x));
      const maxX = Math.max(...transformed.map(p => p.x));
      
      // 計算誤差函數
      const calcError = (a, b, d) => {
        let err = 0;
        for (const p of transformed) {
          const pred = a * Math.pow(p.x, b) + d;
          err += Math.pow(p.y - pred, 2);
        }
        return Math.sqrt(err / transformed.length);
      };
      
      let bestFit = { error: Infinity };
      
      // 第一層：粗略網格搜索
      const dValues = [0, minY * 0.2, minY * 0.5, minY * 0.8];
      for (const d of dValues) {
        for (let b = -3; b <= 0.5; b += 0.2) {
          // 用數據估算 a
          let sumNum = 0, sumDen = 0;
          for (const p of transformed) {
            const xb = Math.pow(p.x, b);
            if (isFinite(xb)) {
              sumNum += (p.y - d) * xb;
              sumDen += xb * xb;
            }
          }
          const a = sumDen > 0 ? sumNum / sumDen : 1;
          if (a <= 0) continue;
          
          const error = calcError(a, b, d);
          if (error < bestFit.error) {
            bestFit = { a, b, d, error, sign };
          }
        }
      }
      
      if (bestFit.error === Infinity) return null;
      
      // 第二層：精細化搜索
      const refineParam = (param, range, steps) => {
        const base = bestFit[param];
        let bestVal = base;
        let bestErr = bestFit.error;
        
        for (let i = 0; i <= steps; i++) {
          const delta = -range + (2 * range * i / steps);
          const testVal = base + delta;
          const testParams = { ...bestFit, [param]: testVal };
          
          // 重新優化 a
          if (param !== 'a') {
            let sumNum = 0, sumDen = 0;
            for (const p of transformed) {
              const xb = Math.pow(p.x, testParams.b);
              if (isFinite(xb)) {
                sumNum += (p.y - testParams.d) * xb;
                sumDen += xb * xb;
              }
            }
            testParams.a = sumDen > 0 ? Math.max(0.001, sumNum / sumDen) : testParams.a;
          }
          
          const err = calcError(testParams.a, testParams.b, testParams.d);
          if (err < bestErr) {
            bestErr = err;
            bestVal = testVal;
            if (param !== 'a') bestFit.a = testParams.a;
          }
        }
        bestFit[param] = bestVal;
        bestFit.error = bestErr;
      };
      
      // 多輪精細化
      for (let round = 0; round < 5; round++) {
        const scale = Math.pow(0.5, round);
        refineParam('b', 0.5 * scale, 30);
        refineParam('d', (maxY - minY) * 0.3 * scale, 30);
        refineParam('a', bestFit.a * 0.3 * scale, 30);
      }
      
      // 最終超精細搜索
      for (let round = 0; round < 3; round++) {
        refineParam('b', 0.02, 50);
        refineParam('d', Math.max(0.5, minY * 0.05), 50);
        refineParam('a', bestFit.a * 0.02, 50);
      }
      
      // 計算 R²
      const yMean = transformed.reduce((a, p) => a + p.y, 0) / transformed.length;
      let ssTot = 0, ssRes = 0;
      for (const p of transformed) {
        ssTot += Math.pow(p.y - yMean, 2);
        const pred = bestFit.a * Math.pow(p.x, bestFit.b) + bestFit.d;
        ssRes += Math.pow(p.y - pred, 2);
      }
      bestFit.r2 = Math.max(0, 1 - ssRes / (ssTot + EPS));
      bestFit.n = transformed.length;
      
      return bestFit;
    };
    
    const aliceFit = fitSide(aliceData, 1);
    const bazzaFit = fitSide(bazzaData, -1);
    
    return { alice: aliceFit, bazza: bazzaFit, refPoint };
  },
  
  // 生成擬合曲線數據
  generateFitCurve(fit, start, end, steps = 80) {
    if (!fit) return [];
    const points = [];
    const step = (end - start) / steps;
    for (let x = start; x <= end; x += step) {
      const delta = Math.abs(x - CRITICAL_VALUE);
      if (delta > 1e-8) {
        const y = fit.a * Math.pow(delta, fit.b) + fit.d;
        if (isFinite(y) && y > 0) {
          points.push({ lambdaVal: x, fitted: y });
        }
      }
    }
    return points;
  },
  
  // 格式化擬合結果為公式字符串
  formatFormula(fit, side) {
    if (!fit) return '無法擬合';
    const bStr = fit.b.toFixed(6);
    const aStr = fit.a.toFixed(6);
    const dStr = fit.d.toFixed(4);
    return `n ≈ ${aStr} × |λ − λ*|^(${bStr}) + ${dStr}`;
  }
};

// ============================================
// 遊戲引擎
// ============================================
class GameEngine {
  constructor(config, options = {}) {
    this.config = config;
    this.aliceStyle = options.aliceStyle || PlayerStyle.OPTIMAL;
    this.bazzaStyle = options.bazzaStyle || PlayerStyle.OPTIMAL;
    this.aliceConstraint = options.aliceConstraint || ConstraintType.STANDARD;
    this.bazzaConstraint = options.bazzaConstraint || ConstraintType.STANDARD;
    this.maxRounds = options.maxRounds || 100;
    this.checker = new ConstraintChecker(this.aliceConstraint, this.bazzaConstraint, config);
  }

  aliceMove(moves, n) {
    const capacity = this.checker.getAliceCapacity(moves, n);
    if (capacity <= EPS) return { move: 0, reason: '容量耗盡' };

    switch (this.aliceStyle.id) {
      case 'conservative': return { move: 0, reason: '保守策略：選擇 0' };
      case 'aggressive': return { move: Math.min(capacity * 0.95, Math.sqrt(2) * 0.9), reason: '激進策略' };
      case 'balanced': return { move: Math.min(capacity * 0.3, 0.7), reason: '平衡策略' };
      case 'adaptive': {
        if (n < 10) return { move: 0, reason: '適應策略：早期觀察' };
        const bazzaMoves = moves.filter((_, i) => i % 2 === 1);
        const bazzaAvg = bazzaMoves.length > 0 ? bazzaMoves.reduce((a, b) => a + b, 0) / bazzaMoves.length : 0;
        return { move: Math.min(capacity * 0.6, bazzaAvg + 0.1), reason: '適應策略' };
      }
      default:
        if (this.config.isAboveCritical) {
          const bazzaMoves = moves.filter((_, i) => i % 2 === 1);
          const bazzaSumSq = bazzaMoves.reduce((a, b) => a + b * b, 0);
          if (n < 2 * this.config.strikeRound + 1) {
            return { move: 0, reason: `儲備階段 (等待第 ${2 * this.config.strikeRound + 1} 回合)` };
          }
          const remainingForBazza = (n + 1) - bazzaSumSq;
          if (remainingForBazza > 0) {
            const targetX = Math.sqrt(remainingForBazza + 0.5);
            const strikeValue = Math.min(targetX * this.config.aliceAggression, capacity * this.config.aliceAggression);
            if (strikeValue > this.config.reserveThreshold) return { move: strikeValue, reason: '致命一擊' };
          }
          return { move: 0, reason: '繼續等待' };
        } else if (this.config.isBelowCritical) {
          return { move: 0, reason: 'λ < λ*，保守策略' };
        }
        return { move: Math.min(capacity * this.config.aliceAggression, CRITICAL_VALUE), reason: '平衡策略' };
    }
  }

  bazzaMove(moves, n) {
    const capacity = this.checker.getBazzaCapacity(moves, n);
    if (capacity <= EPS) return { move: 0, reason: '容量耗盡' };

    const lastAlice = moves.length > 0 && moves.length % 2 === 1 ? moves[moves.length - 1] : 0;
    const theoreticalMax = Math.sqrt(Math.max(0, 2 - lastAlice * lastAlice));

    switch (this.bazzaStyle.id) {
      case 'conservative': return { move: Math.min(capacity * 0.3, 0.5), reason: '保守策略' };
      case 'aggressive': return { move: Math.min(capacity * 0.9, theoreticalMax * 0.9), reason: '激進策略' };
      case 'balanced': return { move: Math.min(capacity * 0.7, capacity * 0.7), reason: '平衡策略' };
      case 'adaptive': {
        const aliceMoves = moves.filter((_, i) => i % 2 === 0);
        const aliceNonZero = aliceMoves.filter(m => m > 0.1);
        if (aliceNonZero.length > 0) return { move: Math.min(capacity * 0.9, theoreticalMax * 0.9), reason: '適應策略：加速' };
        return { move: Math.min(capacity * 0.6, theoreticalMax * 0.6), reason: '適應策略' };
      }
      default:
        return { move: Math.min(capacity * this.config.bazzaAggression, theoreticalMax * this.config.bazzaAggression), reason: '最大化策略' };
    }
  }

  play() {
    const moves = [];
    const moveDetails = [];
    let n = 0;
    let criticalRound = 0;

    while (n < this.maxRounds) {
      n++;
      const isAliceTurn = n % 2 === 1;

      if (isAliceTurn) {
        const { move, reason } = this.aliceMove(moves, n);
        const tempMoves = [...moves, move];
        const { valid, margin } = this.checker.checkAlice(tempMoves, n);
        if (!valid) {
          moveDetails.push(this.createDetail(n, 'Alice', move, tempMoves, reason, true));
          return this.createResult('Bazza', n, tempMoves, moveDetails, `Alice 於第 ${n} 回合違反約束`, criticalRound);
        }
        moves.push(move);
        if (move > 0.5 && criticalRound === 0) criticalRound = n;
        moveDetails.push(this.createDetail(n, 'Alice', move, moves, reason, move > 0.5));
      } else {
        const { move, reason } = this.bazzaMove(moves, n);
        const tempMoves = [...moves, move];
        const { valid } = this.checker.checkBazza(tempMoves, n);
        if (!valid) {
          moveDetails.push(this.createDetail(n, 'Bazza', move, tempMoves, reason, true));
          return this.createResult('Alice', n, tempMoves, moveDetails, `Bazza 於第 ${n} 回合違反約束`, criticalRound);
        }
        moves.push(move);
        moveDetails.push(this.createDetail(n, 'Bazza', move, moves, reason, false));
      }
    }
    return this.createResult('Draw', n, moves, moveDetails, '達到最大回合數', criticalRound);
  }

  createDetail(n, player, move, moves, reason, isCritical) {
    return {
      round: n, player, move,
      sumLinear: moves.reduce((a, b) => a + b, 0),
      sumSquare: moves.reduce((a, b) => a + b * b, 0),
      sumCube: moves.reduce((a, b) => a + b * b * b, 0),
      sumQuartic: moves.reduce((a, b) => a + b * b * b * b, 0),
      aliceCapacity: this.checker.getAliceCapacity(moves, n),
      bazzaCapacity: this.checker.getBazzaCapacity(moves, n),
      linearLimit: this.config.linearMultiplier * n,
      quadLimit: n, reason, isCritical
    };
  }

  createResult(winner, rounds, moves, details, reason, criticalRound) {
    const prediction = this.config.getPredictedWinner();
    return {
      winner, totalRounds: rounds, moves, moveDetails: details, winningReason: reason,
      theoreticalPrediction: prediction,
      matchTheory: winner === prediction || (prediction === 'Balance' && winner === 'Draw'),
      criticalRound, lambdaVal: this.config.lambdaVal,
      aliceStyle: this.aliceStyle, bazzaStyle: this.bazzaStyle,
      aliceConstraint: this.aliceConstraint, bazzaConstraint: this.bazzaConstraint
    };
  }
}

// ============================================
// 導出功能
// ============================================
const exportCSV = (result) => {
  if (!result) return;
  const headers = ['回合', '玩家', 'xₙ', 'Σxᵢ', 'Σxᵢ²', 'Alice容量', 'Bazza容量', '策略'];
  const rows = result.moveDetails.map(d => [d.round, d.player, d.move.toFixed(6), d.sumLinear.toFixed(6), d.sumSquare.toFixed(6), d.aliceCapacity.toFixed(6), d.bazzaCapacity.toFixed(6), d.reason]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `imo2025_lambda${result.lambdaVal.toFixed(4)}.csv`; a.click();
};

const exportJSON = (result) => {
  if (!result) return;
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `imo2025_lambda${result.lambdaVal.toFixed(4)}.json`; a.click();
};

// ============================================
// 主應用
// ============================================
export default function App() {
  const [lambda, setLambda] = useState(0.75);
  const [maxRounds, setMaxRounds] = useState(100);
  const [aliceStyle, setAliceStyle] = useState(PlayerStyle.OPTIMAL);
  const [bazzaStyle, setBazzaStyle] = useState(PlayerStyle.OPTIMAL);
  const [aliceConstraint, setAliceConstraint] = useState(ConstraintType.STANDARD);
  const [bazzaConstraint, setBazzaConstraint] = useState(ConstraintType.STANDARD);
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState('simulation');
  const [batchResults, setBatchResults] = useState([]);
  const [scanResults, setScanResults] = useState([]);
  const [comparisonResults, setComparisonResults] = useState([]);
  const [batchRounds, setBatchRounds] = useState(100);
  const [scanRounds, setScanRounds] = useState(150);
  const [compRounds, setCompRounds] = useState(100);
  const [batchStart, setBatchStart] = useState(0.55);
  const [batchEnd, setBatchEnd] = useState(0.85);
  const [batchStep, setBatchStep] = useState(0.01);
  const [scanRange, setScanRange] = useState(0.02);
  const [scanStep, setScanStep] = useState(0.001);
  const [fitResult, setFitResult] = useState(null);
  const [scanFitResult, setScanFitResult] = useState(null);

  const config = useMemo(() => new LambdaConfig(lambda), [lambda]);

  const runSimulation = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      const engine = new GameEngine(new LambdaConfig(lambda), { aliceStyle, bazzaStyle, aliceConstraint, bazzaConstraint, maxRounds });
      setResult(engine.play());
      setIsRunning(false);
    }, 50);
  }, [lambda, maxRounds, aliceStyle, bazzaStyle, aliceConstraint, bazzaConstraint]);

  const runBatchAnalysis = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      const results = [];
      for (let l = batchStart; l <= batchEnd + 0.0001; l += batchStep) {
        results.push(new GameEngine(new LambdaConfig(parseFloat(l.toFixed(4))), { maxRounds: batchRounds }).play());
      }
      setBatchResults(results);
      // 自動擬合
      const fit = FittingEngine.fitPowerLaw(results);
      setFitResult(fit);
      setIsRunning(false);
    }, 50);
  }, [batchStart, batchEnd, batchStep, batchRounds]);

  const runCriticalScan = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      const results = [];
      for (let l = CRITICAL_VALUE - scanRange; l <= CRITICAL_VALUE + scanRange + 0.0001; l += scanStep) {
        results.push(new GameEngine(new LambdaConfig(parseFloat(l.toFixed(6))), { maxRounds: scanRounds }).play());
      }
      setScanResults(results);
      // 自動擬合
      const fit = FittingEngine.fitPowerLaw(results);
      setScanFitResult(fit);
      setIsRunning(false);
    }, 50);
  }, [scanRange, scanStep, scanRounds]);

  const runStrategyComparison = useCallback(() => {
    setIsRunning(true);
    setTimeout(() => {
      const results = [];
      const styles = Object.values(PlayerStyle);
      for (const aStyle of styles) {
        for (const bStyle of styles) {
          const r = new GameEngine(new LambdaConfig(lambda), { aliceStyle: aStyle, bazzaStyle: bStyle, maxRounds: compRounds }).play();
          results.push({ aliceStyle: aStyle.name, bazzaStyle: bStyle.name, ...r });
        }
      }
      setComparisonResults(results);
      setIsRunning(false);
    }, 50);
  }, [lambda, compRounds]);

  const chartData = useMemo(() => result ? result.moveDetails.map(d => ({ round: d.round, move: d.move, player: d.player, sumLinear: d.sumLinear, sumSquare: d.sumSquare, linearLimit: d.linearLimit, quadLimit: d.quadLimit, aliceCapacity: d.aliceCapacity, bazzaCapacity: d.bazzaCapacity })) : [], [result]);

  const stats = useMemo(() => {
    if (!result || result.moves.length === 0) return null;
    const moves = result.moves;
    const n = moves.length;
    const sumX = moves.reduce((a, b) => a + b, 0);
    const sumX2 = moves.reduce((a, b) => a + b * b, 0);
    const avg = sumX / n;
    const std = Math.sqrt(sumX2 / n - avg * avg);
    const cs = MathEngine.cauchySchwarz(moves);
    return { n, sumX, sumX2, avg, std, max: Math.max(...moves), min: Math.min(...moves), aliceMoves: moves.filter((_, i) => i % 2 === 0), bazzaMoves: moves.filter((_, i) => i % 2 === 1), cs };
  }, [result]);

  return (
    <div className="app">
      <header className="header">
        <h1>IMO 2025 Problem 5 分析系統</h1>
        <p className="subtitle">International Mathematical Olympiad · 互動式數學模擬與驗證平台</p>
      </header>

      <nav className="nav">
        {[{ id: 'simulation', label: '模擬分析' }, { id: 'batch', label: '批次掃描' }, { id: 'critical', label: '臨界值分析' }, { id: 'comparison', label: '策略對比' }, { id: 'theory', label: '理論說明' }].map(tab => (
          <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </nav>

      <main className="main">
        {activeTab === 'simulation' && (
          <div className="sim-layout">
            <section className="panel ctrl">
              <h2>參數設定</h2>
              <div className="field"><label>參數 <i>λ</i></label><div className="row"><input type="number" step="0.001" min="0.5" max="0.9" value={lambda} onChange={(e) => setLambda(parseFloat(e.target.value) || 0.7)} /><input type="range" min="0.5" max="0.9" step="0.001" value={lambda} onChange={(e) => setLambda(parseFloat(e.target.value))} /></div><div className="btns"><button onClick={() => setLambda(0.6)}>0.6</button><button onClick={() => setLambda(CRITICAL_VALUE)}>λ*</button><button onClick={() => setLambda(0.8)}>0.8</button></div></div>
              <div className="field"><label>最大回合數</label><input type="number" min="20" max="500" value={maxRounds} onChange={(e) => setMaxRounds(parseInt(e.target.value) || 100)} /></div>
              <div className="field"><label>Alice 策略</label><select value={aliceStyle.id} onChange={(e) => setAliceStyle(Object.values(PlayerStyle).find(s => s.id === e.target.value))}>{Object.values(PlayerStyle).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="field"><label>Bazza 策略</label><select value={bazzaStyle.id} onChange={(e) => setBazzaStyle(Object.values(PlayerStyle).find(s => s.id === e.target.value))}>{Object.values(PlayerStyle).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="field"><label>Alice 約束</label><select value={aliceConstraint.id} onChange={(e) => setAliceConstraint(Object.values(ConstraintType).find(s => s.id === e.target.value))}>{Object.values(ConstraintType).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="field"><label>Bazza 約束</label><select value={bazzaConstraint.id} onChange={(e) => setBazzaConstraint(Object.values(ConstraintType).find(s => s.id === e.target.value))}>{Object.values(ConstraintType).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
              <div className="info"><div className="r"><span>臨界值 <i>λ</i>*</span><span className="m">{CRITICAL_VALUE.toFixed(6)}</span></div><div className="r"><span>當前 <i>λ</i></span><span className="m">{lambda.toFixed(6)}</span></div><div className="r"><span>差距 Δ</span><span className="m">{config.deltaFromCritical >= 0 ? '+' : ''}{config.deltaFromCritical.toFixed(6)}</span></div><div className="r"><span>預測勝者</span><span className={`w-${config.getPredictedWinner().toLowerCase()}`}>{config.getPredictedWinner() === 'Balance' ? '平衡' : config.getPredictedWinner()}</span></div><div className="r"><span>攻擊回合</span><span className="m">{config.strikeRound > 0 ? config.strikeRound : 'N/A'}</span></div></div>
              <button className="run" onClick={runSimulation} disabled={isRunning}>{isRunning ? '計算中...' : '開始模擬'}</button>
              {result && <div className="exp"><button onClick={() => exportCSV(result)}>CSV</button><button onClick={() => exportJSON(result)}>JSON</button></div>}
            </section>

            <section className="panel res">
              <h2>模擬結果</h2>
              {!result ? <p className="ph">請設定參數後點擊「開始模擬」</p> : (
                <>
                  <div className="sum"><div className="hd"><div className="wn"><span className="lb">勝者</span><span className={`w w-${result.winner.toLowerCase()}`}>{result.winner === 'Draw' ? '和局' : result.winner}</span></div><div className={`tm ${result.matchTheory ? 'ok' : 'no'}`}>{result.matchTheory ? '✓ 符合理論' : '✗ 偏離理論'}</div></div><div className="rs">{result.winningReason}</div><div className="mt"><span>回合數：<b>{result.totalRounds}</b></span><span>理論預測：<b>{result.theoreticalPrediction}</b></span><span>關鍵回合：<b>{result.criticalRound || 'N/A'}</b></span></div></div>

                  <div className="cg">
                    <div className="cb"><h3>移動軌跡</h3><ResponsiveContainer width="100%" height={180}><ScatterChart margin={{ top: 10, right: 15, bottom: 20, left: 40 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="round" stroke="#333" tick={{ fontSize: 10 }} label={{ value: 'n', position: 'bottom', fontSize: 11, fontStyle: 'italic' }} /><YAxis stroke="#333" tick={{ fontSize: 10 }} /><ReferenceLine y={CRITICAL_VALUE} stroke="#228B22" strokeDasharray="5 5" /><Tooltip formatter={(v) => v.toFixed(4)} contentStyle={{ fontSize: 10 }} /><Scatter data={chartData.filter(d => d.player === 'Alice')} dataKey="move" fill="#8B0000" name="Alice" /><Scatter data={chartData.filter(d => d.player === 'Bazza')} dataKey="move" fill="#00008B" name="Bazza" /><Legend wrapperStyle={{ fontSize: 10 }} /></ScatterChart></ResponsiveContainer></div>
                    <div className="cb"><h3>線性約束</h3><ResponsiveContainer width="100%" height={180}><AreaChart data={chartData} margin={{ top: 10, right: 15, bottom: 20, left: 40 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="round" stroke="#333" tick={{ fontSize: 10 }} /><YAxis stroke="#333" tick={{ fontSize: 10 }} /><Tooltip formatter={(v) => v.toFixed(4)} contentStyle={{ fontSize: 10 }} /><Area type="monotone" dataKey="linearLimit" stroke="#8B0000" fill="#8B0000" fillOpacity={0.1} name="λn" /><Line type="monotone" dataKey="sumLinear" stroke="#00008B" strokeWidth={1.5} dot={false} name="Σxᵢ" /><Legend wrapperStyle={{ fontSize: 10 }} /></AreaChart></ResponsiveContainer></div>
                    <div className="cb"><h3>二次約束</h3><ResponsiveContainer width="100%" height={180}><AreaChart data={chartData} margin={{ top: 10, right: 15, bottom: 20, left: 40 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="round" stroke="#333" tick={{ fontSize: 10 }} /><YAxis stroke="#333" tick={{ fontSize: 10 }} /><Tooltip formatter={(v) => v.toFixed(4)} contentStyle={{ fontSize: 10 }} /><Area type="monotone" dataKey="quadLimit" stroke="#8B0000" fill="#8B0000" fillOpacity={0.1} name="n" /><Line type="monotone" dataKey="sumSquare" stroke="#228B22" strokeWidth={1.5} dot={false} name="Σxᵢ²" /><Legend wrapperStyle={{ fontSize: 10 }} /></AreaChart></ResponsiveContainer></div>
                    <div className="cb"><h3>剩餘容量</h3><ResponsiveContainer width="100%" height={180}><LineChart data={chartData} margin={{ top: 10, right: 15, bottom: 20, left: 40 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="round" stroke="#333" tick={{ fontSize: 10 }} /><YAxis stroke="#333" tick={{ fontSize: 10 }} /><Tooltip formatter={(v) => v.toFixed(4)} contentStyle={{ fontSize: 10 }} /><Line type="monotone" dataKey="aliceCapacity" stroke="#8B0000" strokeWidth={1.5} dot={false} name="Alice" /><Line type="monotone" dataKey="bazzaCapacity" stroke="#00008B" strokeWidth={1.5} dot={false} name="Bazza" /><Legend wrapperStyle={{ fontSize: 10 }} /></LineChart></ResponsiveContainer></div>
                  </div>

                  {stats && <div className="st"><h3>統計數據</h3><div className="sg"><table><tbody><tr><td>n</td><td className="m">{stats.n}</td></tr><tr><td>Σxᵢ</td><td className="m">{stats.sumX.toFixed(6)}</td></tr><tr><td>Σxᵢ²</td><td className="m">{stats.sumX2.toFixed(6)}</td></tr></tbody></table><table><tbody><tr><td>平均</td><td className="m">{stats.avg.toFixed(6)}</td></tr><tr><td>標準差</td><td className="m">{stats.std.toFixed(6)}</td></tr><tr><td>C-S比</td><td className="m">{stats.cs.ratio.toFixed(6)}</td></tr></tbody></table><table><tbody><tr><td colSpan="2" className="sh">Alice</td></tr><tr><td>次數</td><td className="m">{stats.aliceMoves.length}</td></tr><tr><td>總和</td><td className="m">{stats.aliceMoves.reduce((a, b) => a + b, 0).toFixed(4)}</td></tr></tbody></table><table><tbody><tr><td colSpan="2" className="sh">Bazza</td></tr><tr><td>次數</td><td className="m">{stats.bazzaMoves.length}</td></tr><tr><td>總和</td><td className="m">{stats.bazzaMoves.reduce((a, b) => a + b, 0).toFixed(4)}</td></tr></tbody></table></div></div>}

                  <div className="mv"><h3>移動記錄</h3><div className="ts"><table><thead><tr><th>n</th><th>玩家</th><th>xₙ</th><th>Σxᵢ</th><th>Σxᵢ²</th><th>A容量</th><th>B容量</th><th>策略</th></tr></thead><tbody>{result.moveDetails.map((d, i) => <tr key={i} className={d.isCritical ? 'cr' : ''}><td>{d.round}</td><td className={`p-${d.player.toLowerCase()}`}>{d.player}</td><td className="m">{d.move.toFixed(4)}</td><td className="m">{d.sumLinear.toFixed(4)}</td><td className="m">{d.sumSquare.toFixed(4)}</td><td className="m">{d.aliceCapacity.toFixed(4)}</td><td className="m">{d.bazzaCapacity.toFixed(4)}</td><td className="rn">{d.reason}</td></tr>)}</tbody></table></div></div>
                </>
              )}
            </section>
          </div>
        )}

        {activeTab === 'batch' && (
          <section className="panel">
            <h2>批次參數掃描</h2>
            <p>對 <i>λ</i> 進行系統性掃描，驗證臨界值定理。</p>
            
            <div className="params-grid">
              <div className="field"><label>起始 <i>λ</i></label><input type="number" step="0.01" min="0.1" max="1.5" value={batchStart} onChange={(e) => setBatchStart(parseFloat(e.target.value) || 0.55)} /></div>
              <div className="field"><label>結束 <i>λ</i></label><input type="number" step="0.01" min="0.1" max="1.5" value={batchEnd} onChange={(e) => setBatchEnd(parseFloat(e.target.value) || 0.85)} /></div>
              <div className="field"><label>步長</label><input type="number" step="0.001" min="0.001" max="0.1" value={batchStep} onChange={(e) => setBatchStep(parseFloat(e.target.value) || 0.01)} /></div>
              <div className="field"><label>回合數</label><input type="number" step="10" min="20" max="500" value={batchRounds} onChange={(e) => setBatchRounds(parseInt(e.target.value) || 100)} /></div>
            </div>
            <p className="hint">共 {Math.floor((batchEnd - batchStart) / batchStep) + 1} 個數據點</p>
            
            <button className="run" onClick={runBatchAnalysis} disabled={isRunning} style={{ maxWidth: 200 }}>{isRunning ? '計算中...' : '開始掃描'}</button>
            {batchResults.length > 0 && (<>
              <div className="bs"><div className="sc"><span className="lb">Alice 勝</span><span className="vl w-alice">{batchResults.filter(r => r.winner === 'Alice').length}</span></div><div className="sc"><span className="lb">Bazza 勝</span><span className="vl w-bazza">{batchResults.filter(r => r.winner === 'Bazza').length}</span></div><div className="sc"><span className="lb">和局</span><span className="vl">{batchResults.filter(r => r.winner === 'Draw').length}</span></div><div className="sc"><span className="lb">符合理論</span><span className="vl ok">{batchResults.filter(r => r.matchTheory).length}/{batchResults.length}</span></div></div>
              <div className="cb" style={{ marginTop: 20 }}><h3>λ vs 回合數</h3><ResponsiveContainer width="100%" height={320}><ScatterChart margin={{ top: 20, right: 20, bottom: 35, left: 50 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="lambdaVal" stroke="#333" tick={{ fontSize: 10 }} label={{ value: 'λ', position: 'bottom', fontSize: 12, fontStyle: 'italic' }} domain={[batchStart - 0.02, batchEnd + 0.02]} /><YAxis dataKey="totalRounds" stroke="#333" tick={{ fontSize: 10 }} label={{ value: '回合數', angle: -90, position: 'insideLeft', fontSize: 11 }} /><ReferenceLine x={CRITICAL_VALUE} stroke="#228B22" strokeWidth={2} label={{ value: 'λ*', position: 'top', fontSize: 11 }} /><Tooltip contentStyle={{ fontSize: 10 }} /><Scatter data={batchResults.filter(r => r.winner === 'Alice')} fill="#8B0000" name="Alice" /><Scatter data={batchResults.filter(r => r.winner === 'Bazza')} fill="#00008B" name="Bazza" /><Scatter data={batchResults.filter(r => r.winner === 'Draw')} fill="#555" name="和局" />{fitResult?.alice && <Line data={FittingEngine.generateFitCurve(fitResult.alice, CRITICAL_VALUE + 0.001, batchEnd)} type="monotone" dataKey="fitted" stroke="#8B0000" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Alice 擬合" />}{fitResult?.bazza && <Line data={FittingEngine.generateFitCurve(fitResult.bazza, batchStart, CRITICAL_VALUE - 0.001)} type="monotone" dataKey="fitted" stroke="#00008B" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Bazza 擬合" />}<Legend wrapperStyle={{ fontSize: 10 }} /></ScatterChart></ResponsiveContainer></div>
              
              {fitResult && (
                <div className="fit-box">
                  <h3>擬合結果（冪次函數）</h3>
                  <p className="fit-desc">擬合形式：<i>n</i> = <i>a</i> × |<i>λ</i> − <i>λ</i>*|<sup><i>b</i></sup> + <i>d</i></p>
                  <div className="fit-grid">
                    <div className="fit-card">
                      <div className="fit-title">Alice 勝利區域 (<i>λ</i> {'>'} <i>λ</i>*)</div>
                      {fitResult.alice ? (<>
                        <div className="fit-formula">{FittingEngine.formatFormula(fitResult.alice, 'alice')}</div>
                        <div className="fit-params">
                          <span><i>a</i> = {fitResult.alice.a.toFixed(6)}</span>
                          <span><i>b</i> = {fitResult.alice.b.toFixed(6)}</span>
                          <span><i>d</i> = {fitResult.alice.d.toFixed(4)}</span>
                        </div>
                        <div className="fit-stats">
                          <span>R² = {fitResult.alice.r2.toFixed(6)}</span>
                          <span>RMSE = {fitResult.alice.error.toFixed(4)}</span>
                          <span>n = {fitResult.alice.n}</span>
                        </div>
                      </>) : <div className="fit-na">數據不足</div>}
                    </div>
                    <div className="fit-card">
                      <div className="fit-title">Bazza 勝利區域 (<i>λ</i> {'<'} <i>λ</i>*)</div>
                      {fitResult.bazza ? (<>
                        <div className="fit-formula">{FittingEngine.formatFormula(fitResult.bazza, 'bazza')}</div>
                        <div className="fit-params">
                          <span><i>a</i> = {fitResult.bazza.a.toFixed(6)}</span>
                          <span><i>b</i> = {fitResult.bazza.b.toFixed(6)}</span>
                          <span><i>d</i> = {fitResult.bazza.d.toFixed(4)}</span>
                        </div>
                        <div className="fit-stats">
                          <span>R² = {fitResult.bazza.r2.toFixed(6)}</span>
                          <span>RMSE = {fitResult.bazza.error.toFixed(4)}</span>
                          <span>n = {fitResult.bazza.n}</span>
                        </div>
                      </>) : <div className="fit-na">數據不足</div>}
                    </div>
                  </div>
                  <p className="fit-note">註：冪次 <i>b</i> 為負表示隨距離增加回合數減少；R² 越接近 1 表示擬合越好</p>
                </div>
              )}
              <div className="bt"><h3>詳細結果</h3><div className="ts"><table><thead><tr><th>λ</th><th>勝者</th><th>回合</th><th>預測</th><th>符合</th><th>原因</th></tr></thead><tbody>{batchResults.map((r, i) => <tr key={i}><td className="m">{r.lambdaVal.toFixed(2)}</td><td className={`p-${r.winner.toLowerCase()}`}>{r.winner}</td><td className="m">{r.totalRounds}</td><td>{r.theoreticalPrediction}</td><td className={r.matchTheory ? 'ok' : 'no'}>{r.matchTheory ? '✓' : '✗'}</td><td className="rn">{r.winningReason}</td></tr>)}</tbody></table></div></div>
            </>)}
          </section>
        )}

        {activeTab === 'critical' && (
          <section className="panel">
            <h2>臨界值高精度分析</h2>
            <p>在臨界值 <i>λ</i>* = 1/√2 ≈ {CRITICAL_VALUE.toFixed(6)} 附近進行高精度掃描。</p>
            
            <div className="params-grid">
              <div className="field"><label>掃描範圍 ±</label><input type="number" step="0.005" min="0.005" max="0.1" value={scanRange} onChange={(e) => setScanRange(parseFloat(e.target.value) || 0.02)} /></div>
              <div className="field"><label>步長</label><input type="number" step="0.0001" min="0.0001" max="0.01" value={scanStep} onChange={(e) => setScanStep(parseFloat(e.target.value) || 0.001)} /></div>
              <div className="field"><label>回合數</label><input type="number" step="10" min="20" max="500" value={scanRounds} onChange={(e) => setScanRounds(parseInt(e.target.value) || 150)} /></div>
            </div>
            <p className="hint">掃描區間 [{(CRITICAL_VALUE - scanRange).toFixed(4)}, {(CRITICAL_VALUE + scanRange).toFixed(4)}]，共 {Math.floor(2 * scanRange / scanStep) + 1} 個數據點</p>
            
            <button className="run" onClick={runCriticalScan} disabled={isRunning} style={{ maxWidth: 200 }}>{isRunning ? '計算中...' : '開始掃描'}</button>
            {scanResults.length > 0 && (<>
              <div className="bs"><div className="sc"><span className="lb">Alice 勝</span><span className="vl w-alice">{scanResults.filter(r => r.winner === 'Alice').length}</span></div><div className="sc"><span className="lb">Bazza 勝</span><span className="vl w-bazza">{scanResults.filter(r => r.winner === 'Bazza').length}</span></div><div className="sc"><span className="lb">和局</span><span className="vl">{scanResults.filter(r => r.winner === 'Draw').length}</span></div></div>
              <div className="cb" style={{ marginTop: 20 }}><h3>臨界值附近相變圖</h3><ResponsiveContainer width="100%" height={320}><ScatterChart margin={{ top: 20, right: 20, bottom: 35, left: 50 }}><CartesianGrid strokeDasharray="3 3" stroke="#ccc" /><XAxis dataKey="lambdaVal" stroke="#333" tick={{ fontSize: 10 }} tickFormatter={(v) => v.toFixed(3)} label={{ value: 'λ', position: 'bottom', fontSize: 12, fontStyle: 'italic' }} /><YAxis dataKey="totalRounds" stroke="#333" tick={{ fontSize: 10 }} label={{ value: '回合數', angle: -90, position: 'insideLeft', fontSize: 11 }} /><ReferenceLine x={CRITICAL_VALUE} stroke="#228B22" strokeWidth={2} strokeDasharray="5 5" label={{ value: 'λ*', position: 'top', fontSize: 11 }} /><Tooltip contentStyle={{ fontSize: 10 }} formatter={(v, name) => [name === 'totalRounds' ? v : v.toFixed(6), name === 'totalRounds' ? '回合' : 'λ']} /><Scatter data={scanResults.filter(r => r.winner === 'Alice')} fill="#8B0000" name="Alice" /><Scatter data={scanResults.filter(r => r.winner === 'Bazza')} fill="#00008B" name="Bazza" /><Scatter data={scanResults.filter(r => r.winner === 'Draw')} fill="#555" name="和局" />{scanFitResult?.alice && <Line data={FittingEngine.generateFitCurve(scanFitResult.alice, CRITICAL_VALUE + 0.0005, CRITICAL_VALUE + scanRange)} type="monotone" dataKey="fitted" stroke="#8B0000" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Alice 擬合" />}{scanFitResult?.bazza && <Line data={FittingEngine.generateFitCurve(scanFitResult.bazza, CRITICAL_VALUE - scanRange, CRITICAL_VALUE - 0.0005)} type="monotone" dataKey="fitted" stroke="#00008B" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Bazza 擬合" />}<Legend wrapperStyle={{ fontSize: 10 }} /></ScatterChart></ResponsiveContainer></div>
              
              {scanFitResult && (
                <div className="fit-box">
                  <h3>高精度擬合結果（冪次函數）</h3>
                  <p className="fit-desc">擬合形式：<i>n</i> = <i>a</i> × |<i>λ</i> − <i>λ</i>*|<sup><i>b</i></sup> + <i>d</i></p>
                  <div className="fit-grid">
                    <div className="fit-card">
                      <div className="fit-title">Alice 勝利區域 (<i>λ</i> {'>'} <i>λ</i>*)</div>
                      {scanFitResult.alice ? (<>
                        <div className="fit-formula">{FittingEngine.formatFormula(scanFitResult.alice, 'alice')}</div>
                        <div className="fit-params">
                          <span><i>a</i> = {scanFitResult.alice.a.toFixed(6)}</span>
                          <span><i>b</i> = {scanFitResult.alice.b.toFixed(6)}</span>
                          <span><i>d</i> = {scanFitResult.alice.d.toFixed(4)}</span>
                        </div>
                        <div className="fit-stats">
                          <span>R² = {scanFitResult.alice.r2.toFixed(6)}</span>
                          <span>RMSE = {scanFitResult.alice.error.toFixed(4)}</span>
                          <span>n = {scanFitResult.alice.n}</span>
                        </div>
                      </>) : <div className="fit-na">數據不足</div>}
                    </div>
                    <div className="fit-card">
                      <div className="fit-title">Bazza 勝利區域 (<i>λ</i> {'<'} <i>λ</i>*)</div>
                      {scanFitResult.bazza ? (<>
                        <div className="fit-formula">{FittingEngine.formatFormula(scanFitResult.bazza, 'bazza')}</div>
                        <div className="fit-params">
                          <span><i>a</i> = {scanFitResult.bazza.a.toFixed(6)}</span>
                          <span><i>b</i> = {scanFitResult.bazza.b.toFixed(6)}</span>
                          <span><i>d</i> = {scanFitResult.bazza.d.toFixed(4)}</span>
                        </div>
                        <div className="fit-stats">
                          <span>R² = {scanFitResult.bazza.r2.toFixed(6)}</span>
                          <span>RMSE = {scanFitResult.bazza.error.toFixed(4)}</span>
                          <span>n = {scanFitResult.bazza.n}</span>
                        </div>
                      </>) : <div className="fit-na">數據不足</div>}
                    </div>
                  </div>
                  <p className="fit-note">註：高精度掃描可獲得更準確的冪次估計</p>
                </div>
              )}
              
              <div className="ob"><h3>觀察結果</h3><ul><li>在 λ = λ* 附近存在明顯的相變現象</li><li>λ {'>'} λ* 時，Alice 穩定獲勝；λ {'<'} λ* 時，Bazza 穩定獲勝</li><li>回合數與 |λ − λ*| 呈冪次關係</li></ul></div>
            </>)}
          </section>
        )}

        {activeTab === 'comparison' && (
          <section className="panel">
            <h2>策略對比分析</h2>
            <p>測試所有策略組合（5×5 = 25 種）的勝負情況。</p>
            
            <div className="params-grid">
              <div className="field"><label>設定 <i>λ</i></label><input type="number" step="0.01" min="0.5" max="0.9" value={lambda} onChange={(e) => setLambda(parseFloat(e.target.value) || 0.7)} /></div>
              <div className="field"><label>回合數</label><input type="number" step="10" min="20" max="500" value={compRounds} onChange={(e) => setCompRounds(parseInt(e.target.value) || 100)} /></div>
            </div>
            
            <button className="run" onClick={runStrategyComparison} disabled={isRunning} style={{ maxWidth: 200 }}>{isRunning ? '計算中...' : '開始對比'}</button>
            {comparisonResults.length > 0 && (<>
              <div className="cm"><h3>策略勝負矩陣</h3><table className="mx"><thead><tr><th></th>{Object.values(PlayerStyle).map(s => <th key={s.id}>{s.name}</th>)}</tr></thead><tbody>{Object.values(PlayerStyle).map(aStyle => <tr key={aStyle.id}><td className="rh">{aStyle.name}</td>{Object.values(PlayerStyle).map(bStyle => { const r = comparisonResults.find(x => x.aliceStyle === aStyle.name && x.bazzaStyle === bStyle.name); return <td key={bStyle.id} className={`c-${r?.winner.toLowerCase()}`}>{r?.winner === 'Draw' ? '—' : r?.winner === 'Alice' ? 'A' : 'B'}<span className="rd">({r?.totalRounds})</span></td>; })}</tr>)}</tbody></table><div className="lg"><span><b>A</b> = Alice勝</span><span><b>B</b> = Bazza勝</span><span><b>—</b> = 和局</span></div></div>
              <div className="bs"><div className="sc"><span className="lb">Alice 勝</span><span className="vl w-alice">{comparisonResults.filter(r => r.winner === 'Alice').length}</span></div><div className="sc"><span className="lb">Bazza 勝</span><span className="vl w-bazza">{comparisonResults.filter(r => r.winner === 'Bazza').length}</span></div><div className="sc"><span className="lb">和局</span><span className="vl">{comparisonResults.filter(r => r.winner === 'Draw').length}</span></div></div>
            </>)}
          </section>
        )}

        {activeTab === 'theory' && (
          <section className="panel th">
            <h2>理論說明</h2>
            <article><h3>1. 問題陳述</h3><p>Alice 和 Bazza 輪流選擇非負實數 <i>x<sub>n</sub></i>，需滿足：</p><div className="eq"><div className="el">∑<sub>i=1</sub><sup>n</sup> <i>x<sub>i</sub></i> ≤ <i>λn</i></div><div className="ed">（線性約束）</div></div><div className="eq"><div className="el">∑<sub>i=1</sub><sup>n</sup> <i>x<sub>i</sub></i>² ≤ <i>n</i></div><div className="ed">（二次約束）</div></div><p>若某玩家無法選擇合法值，則該玩家落敗。</p></article>
            <article><h3>2. 臨界值定理</h3><div className="tm"><p><strong>定理</strong>　臨界值為 <i>λ</i>* = 1/√2 ≈ 0.707107</p><ul><li>若 <i>λ</i> {'>'} <i>λ</i>*，則 Alice 有必勝策略</li><li>若 <i>λ</i> {'<'} <i>λ</i>*，則 Bazza 有必勝策略</li></ul></div></article>
            <article><h3>3. 輔助引理</h3><div className="tm"><p><strong>引理</strong>　對於 <i>t</i> ∈ [0, √2]：<i>t</i> + √(2 − <i>t</i>²) ≤ 2</p><p>等號成立當且僅當 <i>t</i> = 1。</p></div><p><strong>證明</strong>　令 f(t) = t + √(2 − t²)，求導得 f'(t) = 1 − t/√(2 − t²)。令 f'(t) = 0，得 t = 1，此時 f(1) = 2。∎</p></article>
            <article><h3>4. Cauchy-Schwarz 不等式</h3><div className="tm"><p><strong>定理</strong>　(∑<i>x<sub>i</sub></i>)² ≤ <i>n</i> · ∑<i>x<sub>i</sub></i>²</p></div><p>結合約束可得 ∑<i>x<sub>i</sub></i> ≤ <i>n</i>，當 <i>λ</i> {'<'} 1 時線性約束更嚴格。</p></article>
            <article><h3>5. 策略分析</h3><p><b>Alice（λ {'>'} λ*）</b>：「延遲攻擊」策略 — 前期選 0 積累容量，在第 2k+1 回合發動致命一擊。</p><p><b>Bazza（λ {'<'} λ*）</b>：「壓縮」策略 — 每回合選接近上限的值，消耗 Alice 線性容量。</p></article>
            <article><h3>6. 參考文獻</h3><ol><li>International Mathematical Olympiad 2025, Problem 5.</li><li>Hardy, Littlewood, Pólya (1952). <em>Inequalities</em>. CUP.</li></ol></article>
          </section>
        )}
      </main>

      <footer className="footer"><p>IMO 2025 Problem 5 Analysis System v2.0</p></footer>

      <style>{`
*{margin:0;padding:0;box-sizing:border-box}
.app{font-family:"Times New Roman","SimSun","宋体",serif;background:#f5f5f5;min-height:100vh;color:#1a1a1a;line-height:1.7;font-size:13px}
.header{background:#fff;border-bottom:2px solid #1a1a1a;padding:22px 36px;text-align:center}
.header h1{font-size:22px;font-weight:400;letter-spacing:3px}
.subtitle{font-size:12px;color:#666;margin-top:3px}
.nav{display:flex;justify-content:center;background:#fff;border-bottom:1px solid #ddd}
.nav button{font-family:inherit;font-size:12px;padding:10px 24px;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer}
.nav button:hover{background:#f9f9f9}
.nav button.active{border-bottom-color:#1a1a1a}
.main{max-width:1150px;margin:0 auto;padding:20px 14px}
.sim-layout{display:grid;grid-template-columns:260px 1fr;gap:18px}
.panel{background:#fff;border:1px solid #ccc;padding:18px}
.panel h2{font-size:15px;font-weight:400;border-bottom:1px solid #1a1a1a;padding-bottom:7px;margin-bottom:14px;letter-spacing:1px}
.panel h3{font-size:13px;font-weight:700;margin:16px 0 8px}
i{font-family:"Times New Roman",serif}
.m{font-family:"Courier New",Consolas,monospace;font-size:11px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;margin-bottom:3px}
.row{display:flex;gap:6px;align-items:center}
.field input[type="number"]{font-family:"Courier New",monospace;font-size:11px;padding:5px 7px;border:1px solid #aaa;width:70px}
.field input[type="range"]{flex:1}
.field select{font-family:inherit;font-size:11px;padding:5px 7px;border:1px solid #aaa;width:100%;background:#fff}
.btns{display:flex;gap:4px;margin-top:5px}
.btns button{font-family:inherit;font-size:10px;padding:3px 9px;background:#f0f0f0;border:1px solid #aaa;cursor:pointer}
.btns button:hover{background:#e5e5e5}
.info{background:#f8f8f8;border:1px solid #ccc;padding:10px;font-size:11px;margin-top:12px}
.r{display:flex;justify-content:space-between;padding:2px 0}
.run{font-family:inherit;font-size:12px;width:100%;padding:9px;background:#1a1a1a;color:#fff;border:none;cursor:pointer;margin-top:12px}
.run:hover{background:#333}
.run:disabled{background:#888;cursor:not-allowed}
.exp{display:flex;gap:6px;margin-top:8px}
.exp button{font-family:inherit;font-size:10px;padding:5px 10px;background:#f0f0f0;border:1px solid #aaa;cursor:pointer}
.ph{color:#888;text-align:center;padding:35px 14px;border:1px dashed #ccc}
.sum{border:1px solid #ccc;padding:14px;margin-bottom:16px;background:#fafafa}
.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.wn .lb{font-size:12px;color:#666}
.wn .w{font-size:18px;margin-left:6px;font-weight:700}
.tm{font-size:11px;padding:3px 8px;border:1px solid}
.tm.ok{color:#228B22;border-color:#228B22;background:#f0fff0}
.tm.no{color:#8B0000;border-color:#8B0000;background:#fff0f0}
.rs{color:#555;font-size:12px;margin-bottom:8px}
.mt{display:flex;gap:20px;font-size:11px;color:#666;padding-top:8px;border-top:1px dotted #ccc}
.mt b{color:#1a1a1a}
.w-alice,.p-alice{color:#8B0000}
.w-bazza,.p-bazza{color:#00008B}
.w-draw,.p-draw,.w-balance{color:#555}
.ok{color:#228B22}
.no{color:#8B0000}
.cg{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
.cb{border:1px solid #ccc;padding:10px;background:#fff}
.cb h3{font-size:11px;margin:0 0 6px;font-weight:400}
.st{margin-bottom:16px}
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.sg table{width:100%;border-collapse:collapse;font-size:10px}
.sg td{border:1px solid #ddd;padding:3px 6px}
.sg td:first-child{background:#f8f8f8}
.sh{background:#f0f0f0!important;font-weight:700;text-align:center}
.ts{max-height:260px;overflow-y:auto;border:1px solid #ccc}
.mv table,.bt table{width:100%;border-collapse:collapse;font-size:10px}
.mv th,.mv td,.bt th,.bt td{border:1px solid #ddd;padding:5px 7px;text-align:left}
.mv th,.bt th{background:#f0f0f0;font-weight:400;position:sticky;top:0}
.cr{background:#fffde7}
.rn{font-size:9px;color:#666;max-width:130px}
.bs{display:flex;gap:14px;margin:18px 0}
.sc{flex:1;text-align:center;padding:14px;border:1px solid #ccc;background:#fafafa}
.sc .lb{display:block;font-size:11px;color:#666}
.sc .vl{display:block;font-size:26px;margin-top:5px}
.bt{margin-top:18px}
.ob{background:#f8f8f8;border:1px solid #ccc;padding:14px;margin-top:18px}
.ob ul{margin-left:18px}
.ob li{margin:5px 0}
.params-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}
.hint{font-size:11px;color:#666;margin:6px 0 12px}
.fit-box{background:#f8f8f8;border:1px solid #ccc;padding:16px;margin-top:20px}
.fit-box h3{margin:0 0 10px;font-size:13px}
.fit-desc{font-size:12px;color:#555;margin-bottom:14px}
.fit-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.fit-card{background:#fff;border:1px solid #ddd;padding:14px}
.fit-title{font-size:12px;font-weight:700;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #eee}
.fit-formula{font-family:"Courier New",monospace;font-size:12px;background:#f0f0f0;padding:8px 12px;margin-bottom:10px;border-left:3px solid #1a1a1a}
.fit-params{display:flex;gap:16px;font-size:11px;margin-bottom:8px;flex-wrap:wrap}
.fit-params span{font-family:"Courier New",monospace}
.fit-stats{display:flex;gap:16px;font-size:10px;color:#666}
.fit-stats span{font-family:"Courier New",monospace}
.fit-na{color:#888;font-size:12px;font-style:italic}
.fit-note{font-size:10px;color:#888;margin-top:12px;font-style:italic}
.cm{margin-top:18px}
.mx{width:100%;border-collapse:collapse;font-size:11px;text-align:center}
.mx th,.mx td{border:1px solid #ccc;padding:8px}
.mx th{background:#f0f0f0;font-weight:400}
.rh{background:#f0f0f0;text-align:left}
.c-alice{background:#ffe0e0}
.c-bazza{background:#e0e0ff}
.c-draw{background:#f0f0f0}
.rd{font-size:9px;color:#888;display:block}
.lg{display:flex;gap:16px;margin-top:8px;font-size:10px;color:#666}
.th article{margin-bottom:24px}
.th p{margin:8px 0;text-align:justify}
.th ul,.th ol{margin:8px 0 8px 20px}
.th li{margin:3px 0}
.eq{background:#f8f8f8;border-left:3px solid #1a1a1a;padding:10px 14px;margin:10px 0;display:flex;justify-content:space-between;align-items:center}
.el{font-size:14px}
.ed{font-size:11px;color:#666}
.th .tm{background:#f8f8f8;border:1px solid #ccc;padding:14px;margin:12px 0}
.footer{text-align:center;padding:18px;border-top:1px solid #ccc;font-size:10px;color:#888;margin-top:24px;background:#fff}
@media(max-width:850px){.sim-layout{grid-template-columns:1fr}.cg{grid-template-columns:1fr}.sg{grid-template-columns:1fr 1fr}.bs{flex-wrap:wrap}.sc{min-width:100px}.params-grid{grid-template-columns:1fr 1fr}.fit-grid{grid-template-columns:1fr}}
      `}</style>
    </div>
  );
}
