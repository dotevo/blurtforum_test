import { ref } from 'vue';
import * as dblurt from '@beblurt/dblurt';
import { createFailoverPool } from './rpcFailover';

const DEFAULT_RPC = 'https://rpc.drakernoise.com';

// Candidate pools mirror the two dropdowns in RpcModal.vue. Kept separate
// on purpose — see rpcFailover.ts's header comment for why a forum-endpoint
// read must never fail over into a plain official-API-only node.
const DATA_POOL = [
  'https://blurtrpc.dagobert.uk',
  'https://rpc.blurt.blog',
  'https://rpc.beblurt.com',
  'https://rpc.drakernoise.com',
];
const FORUM_POOL = [
  'https://blurtrpc.dagobert.uk',
  'https://rpc.drakernoise.com',
  'https://rpc.beblurt.com',
];

/** Puts the user's explicitly-selected node first (their choice always
 * wins the first attempt), then the rest of the standard pool as fallback. */
function orderedPool(selectedUrl: string, basePool: string[]): string[] {
  if (!selectedUrl) return basePool;
  return [selectedUrl, ...basePool.filter((u) => u !== selectedUrl)];
}

/**
 * Manages RPC node selection and dblurt client instances.
 * Clients are exposed as refs so consumers reactively get the latest instance
 * after applyRpcSettings() is called.
 *
 * dataClient/forumClient are now failover-wrapped (see rpcFailover.ts): a
 * read that fails on the user's selected node automatically retries the
 * rest of that node's pool before giving up, and — if a different node
 * turns out to work — that becomes the new remembered default. The
 * selected dropdown value in RpcModal.vue still reflects the user's
 * explicit choice; failover is a silent, transparent safety net underneath
 * it, not a replacement for it.
 */
export function useRpc() {
  const rpcMenuOpen   = ref(false);
  const rpcForumNode  = ref(localStorage.getItem('bf-rpc-forum') || DEFAULT_RPC);
  const rpcDataNode   = ref(localStorage.getItem('bf-rpc-data')  || DEFAULT_RPC);
  const rpcForumCustom = ref('');
  const rpcDataCustom  = ref('');

  // Last node that actually worked, if failover ever kicked in — purely
  // informational (e.g. for a future "connected via X" indicator);
  // doesn't drive any logic itself.
  const dataFailoverNotice = ref<string | null>(null);
  const forumFailoverNotice = ref<string | null>(null);

  const getForumUrl = () => rpcForumNode.value === 'custom' ? rpcForumCustom.value : rpcForumNode.value;
  const getDataUrl  = () => rpcDataNode.value  === 'custom' ? rpcDataCustom.value  : rpcDataNode.value;

  function buildDataClient(): dblurt.Client {
    return createFailoverPool(orderedPool(getDataUrl(), DATA_POOL), 'bf-rpc-data-active', (url) => {
      dataFailoverNotice.value = url;
    }).client;
  }
  function buildForumClient(): dblurt.Client {
    return createFailoverPool(orderedPool(getForumUrl(), FORUM_POOL), 'bf-rpc-forum-active', (url) => {
      forumFailoverNotice.value = url;
    }).client;
  }

  const forumClient = ref<dblurt.Client>(buildForumClient());
  const dataClient  = ref<dblurt.Client>(buildDataClient());

  const applyRpcSettings = () => {
    const fUrl = getForumUrl();
    const dUrl = getDataUrl();
    if (!fUrl || !dUrl) return;
    forumClient.value = buildForumClient();
    dataClient.value  = buildDataClient();
    localStorage.setItem('bf-rpc-forum', fUrl);
    localStorage.setItem('bf-rpc-data',  dUrl);
  };

  return {
    getForumUrl,
    getDataUrl,
    rpcMenuOpen,
    rpcForumNode,
    rpcDataNode,
    rpcForumCustom,
    rpcDataCustom,
    forumClient,
    dataClient,
    dataFailoverNotice,
    forumFailoverNotice,
    applyRpcSettings,
  };
}
