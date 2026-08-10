import { createPublicClient, http, defineChain, getAddress } from "viem";
const RPC="https://coston2-api.flare.network/ext/C/rpc";
const c=defineChain({id:114,name:"c2",nativeCurrency:{name:"C2FLR",symbol:"C2FLR",decimals:18},rpcUrls:{default:{http:[RPC]}},testnet:true});
const pub=createPublicClient({chain:c,transport:http(RPC,{retryCount:10,retryDelay:3000,timeout:30000})});
const M=getAddress("0xD709773A1128c1160b292F505FAA8E3e8d0786fF");
const id="0x1a9ee000d5fbf5aaab0f0f0a8582606dece7bfa3960d83ba978ac87548cc38ea";
const A=[{type:"function",name:"isResolved",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"bool"}]},
 {type:"function",name:"winningOutcome",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"uint32"}]}];
for (let i=0;i<60;i++) {
  try {
    if (await pub.readContract({address:M,abi:A,functionName:"isResolved",args:[id]})) {
      const w=await pub.readContract({address:M,abi:A,functionName:"winningOutcome",args:[id]});
      console.log("RESOLVED winner="+w.toString()+" ("+(Number(w)===0?"YES":"NO")+")"); process.exit(0);
    }
  } catch { /* rpc busy */ }
  await new Promise(r=>setTimeout(r,45000));
}
console.log("timed out waiting");
