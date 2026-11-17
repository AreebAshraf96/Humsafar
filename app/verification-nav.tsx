"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {validSession} from '@/lib/supabase-auth';

export function AdminRequestsLink({className='nav-link'}:{className?:string}){
 const [isAdmin,setIsAdmin]=useState(false);
 useEffect(()=>{
  let active=true;
  async function refresh(){
   try{const session=await validSession();if(!session){if(active)setIsAdmin(false);return;}
    const response=await fetch('/api/verification-access',{headers:{Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
    const data=await response.json() as {isAdmin?:boolean};if(active)setIsAdmin(response.ok&&data.isAdmin===true);
   }catch{if(active)setIsAdmin(false)}
  }
  const timer=setTimeout(()=>void refresh(),0);window.addEventListener('focus',refresh);
  return()=>{active=false;clearTimeout(timer);window.removeEventListener('focus',refresh)};
 },[]);
 return isAdmin?<Link className={className} href="/admin/driver-verifications">Requests</Link>:null;
}
export default function VerificationNav(){
 return <nav className="verification-tabs" aria-label="Verification navigation"><Link className="nav-link" href="/driver-verification">My verification</Link><AdminRequestsLink/></nav>;
}
