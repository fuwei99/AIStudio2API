'use strict';

/**
 * Public library surface.
 *
 * The one intentionally missing piece is the VM proof algorithm itself:
 * `NodeVmProofProvider.snapshot()` currently returns botguard's `FNL...`
 * production guard.  Everything else (bundle host, Waa/Create, program
 * download, auth, wire builder, RPC transport, response parser, server, WS
 * executor) is implemented locally.
 */

const { loadConfig, DEFAULTS } = require('./config');
const { createLogger } = require('./logger');
const { Runtime, sha256Hex } = require('./runtime');
const { loadMakerSuite, instrumentBotguardProgram } = require('./browser/loader');
const { createBrowserEnv } = require('./browser/env');
const { WaaService } = require('./waa/service');
const { GeminiClient, GenerateError, parseMessage } = require('./waa/client');
const { buildRequest, digestRequest, setProof } = require('./waa/request');
const { createProofProvider, BrowserProofProvider, NodeVmProofProvider, StaticProofProvider } = require('./proof');
const { parseCookieInput, loadCookieFile, toCookieHeader, buildAuthorization, sapisidHash } = require('./google/auth');
const { startServer } = require('./server');
const { CatiecliExecutor } = require('./ws/executor');

module.exports = {
  loadConfig,
  DEFAULTS,
  createLogger,
  Runtime,
  sha256Hex,
  loadMakerSuite,
  instrumentBotguardProgram,
  createBrowserEnv,
  WaaService,
  GeminiClient,
  GenerateError,
  parseMessage,
  buildRequest,
  digestRequest,
  setProof,
  createProofProvider,
  BrowserProofProvider,
  NodeVmProofProvider,
  StaticProofProvider,
  parseCookieInput,
  loadCookieFile,
  toCookieHeader,
  buildAuthorization,
  sapisidHash,
  startServer,
  CatiecliExecutor,
};
