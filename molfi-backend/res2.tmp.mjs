import { createPublicClient, http, defineChain, getAddress } from "viem";
const RPC="https://coston2-api.flare.network/ext/C/rpc";
const c=defineChain({id:114,name:"c2",nativeCurrency:{name:"C2FLR",symbol:"C2FLR",decimals:18},rpcUrls:{default:{http:[RPC]}},testnet:true});
const pub=createPublicClient({chain:c,transport:http(RPC)});
const M=getAddress("0xD709773A1128c1160b292F505FAA8E3e8d0786fF");
const id="0x1a9ee000d5fbf5aaab0f0f0a8582606dece7bfa3960d83ba978ac87548cc38ea";
const A=[{type:"function",name:"isResolved",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"bool"}]},
 {type:"function",name:"winningOutcome",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"uint32"}]}];
try {
  const r=await pub.readContract({address:M,abi:A,functionName:"isResolved",args:[id]});
  if (r) console.log("resolved: true winner="+(await pub.readContract({address:M,abi:A,functionName:"winningOutcome",args:[id]})).toString());
  else console.log("resolved: false");
} catch(e) { console.log("rpc busy:", (e.shortMessage||e.message).split("\n")[0]); }
