import { ref } from 'vue';
import * as dblurt from '@beblurt/dblurt';

const DEFAULT_RPC = 'https://rpc.drakernoise.com';

/**
 * Manages RPC node selection and dblurt client instances.
 * Clients are exposed as refs so consumers reactively get the latest instance
 * after applyRpcSettings() is called.
 */
export function useRpc() {
  const rpcMenuOpen   = ref(false);
  const rpcForumNode  = ref(localStorage.getItem('bf-rpc-forum') || DEFAULT_RPC);
  const rpcDataNode   = ref(localStorage.getItem('bf-rpc-data')  || DEFAULT_RPC);
  const rpcForumCustom = ref('');
  const rpcDataCustom  = ref('');

  const getForumUrl = () => rpcForumNode.value === 'custom' ? rpcForumCustom.value : rpcForumNode.value;
  const getDataUrl  = () => rpcDataNode.value  === 'custom' ? rpcDataCustom.value  : rpcDataNode.value;

  const forumClient = ref<dblurt.Client>(new dblurt.Client([getForumUrl()]));
  const dataClient  = ref<dblurt.Client>(new dblurt.Client([getDataUrl()]));

  const applyRpcSettings = () => {
    const fUrl = getForumUrl();
    const dUrl = getDataUrl();
    if (!fUrl || !dUrl) return;
    forumClient.value = new dblurt.Client([fUrl]);
    dataClient.value  = new dblurt.Client([dUrl]);
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
    applyRpcSettings,
  };
}
