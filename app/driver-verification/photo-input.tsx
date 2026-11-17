"use client";

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

export default function PhotoInput({id,label,facing,file,onChange}:{id:string;label:string;facing:'user'|'environment';file:File|null;onChange:(file:File|null)=>void}) {
 const [preview,setPreview]=useState('');
 const [camera,setCamera]=useState(false);
 const [ready,setReady]=useState(false);
 const [error,setError]=useState('');
 const video=useRef<HTMLVideoElement>(null);
 const cameraDialog=useRef<HTMLDialogElement>(null);
 const picker=useRef<HTMLInputElement>(null);
 const phoneCamera=useRef<HTMLInputElement>(null);
 useEffect(()=>{
  const url=file?URL.createObjectURL(file):'';
  const timer=setTimeout(()=>setPreview(url),0);
  return()=>{clearTimeout(timer);if(url)URL.revokeObjectURL(url)};
 },[file]);
 useEffect(()=>{
  if(!camera)return;
  cameraDialog.current?.showModal();
  let active=true;let stream:MediaStream|undefined;
  void navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:1600},height:{ideal:1200}},audio:false}).then(value=>{
   if(!active){value.getTracks().forEach(track=>track.stop());return;}
   stream=value;if(video.current)video.current.srcObject=value;
  }).catch(()=>{if(active){setError('Camera could not open. Allow camera access, use your phone camera, or choose an existing image.');setCamera(false)}});
  return()=>{active=false;stream?.getTracks().forEach(track=>track.stop())};
 },[camera,facing]);
 function choose(value:File|null){
  if(value&&(value.size===0||value.size>5*1024*1024||!['image/jpeg','image/png','image/webp'].includes(value.type))){setError('Choose a JPG, PNG, or WebP image up to 5 MB.');return;}
  setError('');onChange(value);
 }
 function openCamera(){setError('');setReady(false);if(!navigator.mediaDevices?.getUserMedia){phoneCamera.current?.click();return;}setCamera(true)}
 async function capture(){
  const source=video.current;if(!source?.videoWidth||!ready)return;
  const scale=Math.min(1,1600/Math.max(source.videoWidth,source.videoHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.round(source.videoWidth*scale);canvas.height=Math.round(source.videoHeight*scale);
  const context=canvas.getContext('2d');if(!context){setError('Could not capture this photo. Try choosing an image.');return;}
  context.drawImage(source,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.9));
  if(!blob){setError('Could not capture this photo. Please retry.');return;}
  choose(new File([blob],id+'-camera.jpg',{type:'image/jpeg'}));setCamera(false);
 }
 return <div className="field"><label htmlFor={id}>{label}</label>
  <input ref={picker} id={id} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>{choose(event.currentTarget.files?.[0]||null);event.currentTarget.value=''}}/>
  <input ref={phoneCamera} aria-label={label+' phone camera'} type="file" accept="image/jpeg,image/png,image/webp" capture={facing} hidden onChange={event=>{choose(event.currentTarget.files?.[0]||null);event.currentTarget.value=''}}/>
  <div className="actions"><button type="button" className="outline" onClick={openCamera}>Take {facing==='user'?'live selfie':'licence photo'}</button><button type="button" className="outline" onClick={()=>picker.current?.click()}>Choose from device</button><button type="button" className="subtle" onClick={()=>phoneCamera.current?.click()}>Use phone camera</button></div>
  <small>Choose from Photos, Gallery, Files or connected providers offered by your device. JPG, PNG or WebP, up to 5 MB.</small>
  {preview&&<><Image unoptimized width={640} height={480} className="verification-image-preview" style={{width:'100%',height:'auto'}} src={preview} alt={label+' preview'}/><button type="button" className="subtle" onClick={()=>choose(null)}>Remove / choose another</button></>}
  {error&&<p className="banner error" role="alert">{error}</p>}
  {camera&&<dialog ref={cameraDialog} onCancel={()=>setCamera(false)} aria-label={label+' camera'} className="verification-camera"><h3>{label}</h3><video ref={video} autoPlay muted playsInline onLoadedData={()=>setReady(true)} style={{width:'100%',maxHeight:450,objectFit:'contain',background:'#111'}}/><p>Keep the image clear and well lit. Camera capture alone does not establish liveness.</p><div className="actions"><button type="button" className="primary" disabled={!ready} onClick={()=>void capture()}>Capture photo</button><button type="button" className="outline" onClick={()=>setCamera(false)}>Cancel camera</button></div></dialog>}
 </div>;
}
