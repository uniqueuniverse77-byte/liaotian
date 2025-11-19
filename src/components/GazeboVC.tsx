// src/components/GazeboVC.tsx
import React, { useState, useEffect, useRef } from 'react';
import Peer from 'peerjs';
import { 
  Mic, MicOff, Video, VideoOff, Monitor, PhoneOff, 
  Maximize2, Minimize2, Users, Settings, Volume2 
} from 'lucide-react';
import { supabase, Profile } from '../lib/supabase';

interface VoicePeer {
  peerId: string;
  userId: string;
  stream?: MediaStream;
  profile?: Profile;
  isMuted?: boolean;
  isVideoOff?: boolean;
  isScreenSharing?: boolean;
}

interface GazeboVCProps {
  channelId: string;
  channelName: string;
  user: any; // Current auth user
  onDisconnect: () => void;
  isMinimized?: boolean;
  onToggleMinimize?: () => void;
}

export const GazeboVC: React.FC<GazeboVCProps> = ({ 
  channelId, 
  channelName, 
  user, 
  onDisconnect,
  isMinimized = false,
  onToggleMinimize
}) => {
  // --- State ---
  const [peers, setPeers] = useState<Record<string, VoicePeer>>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(false); // Default to audio-only
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [focusedPeerId, setFocusedPeerId] = useState<string | null>(null);
  const [volumeMap, setVolumeMap] = useState<Record<string, number>>({});

  // --- Refs ---
  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const presenceChannelRef = useRef<any>(null);

  // --- Init Voice Connection ---
  useEffect(() => {
    if (!user || !channelId) return;

    const init = async () => {
      try {
        // 1. Get Local Stream (Audio only initially)
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: true, 
          video: false 
        });
        setLocalStream(stream);
        localStreamRef.current = stream;

        // 2. Init PeerJS
        const myPeerId = `${user.id}-${channelId}`; // Unique per channel to avoid conflicts
        const peer = new Peer(myPeerId);
        peerRef.current = peer;

        peer.on('open', (id) => {
          console.log('My peer ID is: ' + id);
          joinPresenceChannel(myPeerId, stream);
        });

        // 3. Handle Incoming Calls
        peer.on('call', (call) => {
          call.answer(stream);
          handleCallStream(call);
        });

        peer.on('error', (err) => console.error('PeerJS Error:', err));

      } catch (err) {
        console.error("Failed to access media devices", err);
        alert("Could not access microphone. Please check permissions.");
        onDisconnect();
      }
    };

    init();

    return () => {
      cleanup();
    };
  }, [channelId]);

  const cleanup = () => {
    if (presenceChannelRef.current) presenceChannelRef.current.unsubscribe();
    if (peerRef.current) peerRef.current.destroy();
    if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
    }
    setPeers({});
    setLocalStream(null);
  };

  // --- Supabase Presence for Signaling ---
  const joinPresenceChannel = (myPeerId: string, stream: MediaStream) => {
    const channel = supabase.channel(`vc:${channelId}`);
    presenceChannelRef.current = channel;

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const users = Object.values(state).flat() as any[];

        // Connect to new users
        users.forEach((u) => {
           if (u.peerId !== myPeerId && !peers[u.peerId]) {
               // We assume alphabetical sort determines who calls whom to avoid double calls
               if (myPeerId > u.peerId) {
                   const call = peerRef.current!.call(u.peerId, stream);
                   handleCallStream(call, u.user_id);
               }
           }
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ 
             user_id: user.id, 
             peerId: myPeerId,
             isMuted: !isMicOn,
             isVideoOff: !isCameraOn 
          });
        }
      });
  };

  const handleCallStream = (call: Peer.MediaConnection, knownUserId?: string) => {
      const remotePeerId = call.peer;
      // Extract user ID from peer ID format "userid-channelid"
      const userId = knownUserId || remotePeerId.split('-')[0];

      // Fetch profile asynchronously
      supabase.from('profiles').select('*').eq('id', userId).single()
        .then(({ data }) => {
            setPeers(prev => ({
                ...prev,
                [remotePeerId]: { 
                    peerId: remotePeerId, 
                    userId, 
                    profile: data || undefined 
                }
            }));
        });

      call.on('stream', (remoteStream) => {
          setPeers(prev => ({
              ...prev,
              [remotePeerId]: { ...prev[remotePeerId], stream: remoteStream }
          }));
      });

      call.on('close', () => {
          setPeers(prev => {
              const newPeers = { ...prev };
              delete newPeers[remotePeerId];
              return newPeers;
          });
      });
  };

  // --- Controls ---

  const toggleMic = () => {
      if (localStream) {
          const audioTrack = localStream.getAudioTracks()[0];
          if (audioTrack) {
              audioTrack.enabled = !audioTrack.enabled;
              setIsMicOn(audioTrack.enabled);
          }
      }
  };

  const toggleCamera = async () => {
      if (!localStream) return;
      
      if (isCameraOn) {
          // Turn off
          localStream.getVideoTracks().forEach(t => t.stop());
          setLocalStream(new MediaStream([localStream.getAudioTracks()[0]]));
          setIsCameraOn(false);
          // Note: In a real app, you need to re-negotiate connection or replaceTrack here
      } else {
          // Turn on
          try {
              const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
              const videoTrack = videoStream.getVideoTracks()[0];
              
              // Add video track to local stream
              const newStream = new MediaStream([localStream.getAudioTracks()[0], videoTrack]);
              setLocalStream(newStream);
              setIsCameraOn(true);
              
              // Replace tracks for all active calls
              Object.values(peerRef.current?.connections || {}).forEach((conns: any) => {
                   conns.forEach((conn: any) => {
                       const sender = conn.peerConnection.getSenders().find((s: any) => s.track?.kind === 'video');
                       if (sender) sender.replaceTrack(videoTrack);
                       else conn.peerConnection.addTrack(videoTrack, newStream);
                   });
              });
          } catch (err) {
              console.error("Failed to start video", err);
          }
      }
  };

  const toggleScreenShare = async () => {
      if (isScreenSharing) {
          // Stop sharing - revert to camera or audio only
          if (isCameraOn) {
              // Re-fetch camera
              const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
              const videoTrack = camStream.getVideoTracks()[0];
              replaceVideoTrack(videoTrack);
          } else {
              // Stop video track
              localStream?.getVideoTracks().forEach(t => t.stop());
              setLocalStream(new MediaStream(localStream?.getAudioTracks()));
          }
          setIsScreenSharing(false);
      } else {
          // Start sharing
          try {
              const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
              const screenTrack = displayStream.getVideoTracks()[0];
              
              screenTrack.onended = () => toggleScreenShare(); // Handle UI stop button
              replaceVideoTrack(screenTrack);
              
              setIsScreenSharing(true);
          } catch (e) {
              console.error("Screen share cancelled or failed");
          }
      }
  };

  const replaceVideoTrack = (newTrack: MediaStreamTrack) => {
      if (!localStream) return;
      const oldVideoTrack = localStream.getVideoTracks()[0];
      if (oldVideoTrack) oldVideoTrack.stop();

      const newStream = new MediaStream([localStream.getAudioTracks()[0], newTrack]);
      setLocalStream(newStream);

      // Update peers
      Object.values(peerRef.current?.connections || {}).forEach((conns: any) => {
        conns.forEach((conn: any) => {
            const sender = conn.peerConnection.getSenders().find((s: any) => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(newTrack);
            else conn.peerConnection.addTrack(newTrack, newStream);
        });
     });
  };

  // --- Render Helpers ---

  const VideoTile = ({ peer, isLocal = false }: { peer: Partial<VoicePeer>, isLocal?: boolean }) => {
      const videoRef = useRef<HTMLVideoElement>(null);
      
      useEffect(() => {
          if (videoRef.current && peer.stream) {
              videoRef.current.srcObject = peer.stream;
          }
      }, [peer.stream]);

      const hasVideo = peer.stream?.getVideoTracks().length! > 0 && peer.stream?.getVideoTracks()[0].enabled;

      return (
          <div 
            className={`relative bg-gray-900 rounded-xl overflow-hidden border border-gray-800 group transition-all duration-300 ${focusedPeerId === peer.peerId ? 'col-span-full row-span-full z-10' : 'h-full min-h-[180px]'}`}
            onDoubleClick={() => setFocusedPeerId(focusedPeerId === peer.peerId ? null : peer.peerId!)}
          >
              {/* Video/Avatar Layer */}
              {hasVideo ? (
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted={isLocal} 
                    className={`w-full h-full ${isScreenSharing && isLocal ? 'object-contain' : 'object-cover'}`} 
                  />
              ) : (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                      <img 
                        src={peer.profile?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${peer.userId}`} 
                        className={`rounded-full shadow-lg transition-transform duration-300 ${volumeMap[peer.peerId!] > 0.05 ? 'scale-110 ring-4 ring-green-500' : 'grayscale scale-100'}`}
                        style={{ width: '80px', height: '80px' }}
                      />
                  </div>
              )}

              {/* Overlay Info */}
              <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent flex justify-between items-center">
                  <div className="flex items-center gap-2">
                      {peer.isMuted ? <MicOff size={14} className="text-red-500" /> : <Mic size={14} className="text-green-400" />}
                      <span className="text-white text-sm font-bold shadow-black drop-shadow-md">
                          {isLocal ? 'You' : peer.profile?.display_name || 'Connecting...'}
                      </span>
                  </div>
                  {/* Audio Visualizer (Simple Dot) */}
                  {!peer.isMuted && <div className={`w-2 h-2 rounded-full ${volumeMap[peer.peerId!] > 0.05 ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />}
              </div>
              
              {/* Focus Toggle Button */}
              <button 
                 onClick={() => setFocusedPeerId(focusedPeerId === peer.peerId ? null : peer.peerId!)}
                 className="absolute top-2 right-2 p-1 bg-black/40 hover:bg-black/60 rounded text-white opacity-0 group-hover:opacity-100 transition"
              >
                  {focusedPeerId === peer.peerId ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}
              </button>
          </div>
      );
  };

  // --- Mini Mode Render ---
  if (isMinimized) {
      return (
          <div className="fixed bottom-20 right-4 w-64 bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] rounded-xl shadow-2xl overflow-hidden z-[60] animate-in slide-in-from-bottom-10">
              <div className="bg-green-500 p-2 flex justify-between items-center text-white">
                  <span className="font-bold text-xs flex items-center gap-1"><Volume2 size={14}/> Connected</span>
                  <div className="flex gap-2">
                    <button onClick={onToggleMinimize}><Maximize2 size={14}/></button>
                    <button onClick={onDisconnect}><PhoneOff size={14}/></button>
                  </div>
              </div>
              <div className="p-3 grid grid-cols-4 gap-2">
                  {[...Object.values(peers), { userId: user.id, profile: { avatar_url: user.user_metadata.avatar_url } }].map((p: any, i) => (
                      <img key={i} src={p.profile?.avatar_url} className="w-full aspect-square rounded-full bg-gray-700 object-cover border border-gray-600" />
                  ))}
              </div>
              <div className="p-2 bg-[rgb(var(--color-surface-hover))] text-center text-xs text-[rgb(var(--color-text-secondary))]">
                  {channelName}
              </div>
          </div>
      );
  }

  // --- Full Mode Render ---
  const allParticipants = [
      { peerId: 'local', userId: user.id, stream: localStream || undefined, profile: { ...user.user_metadata, display_name: user.user_metadata.display_name || 'You' }, isMuted: !isMicOn },
      ...Object.values(peers)
  ];

  // Grid Calculation
  const count = allParticipants.length;
  const gridClass = focusedPeerId 
     ? 'grid-cols-1 grid-rows-1' 
     : count === 1 ? 'grid-cols-1' 
     : count === 2 ? 'grid-cols-1 md:grid-cols-2' 
     : count <= 4 ? 'grid-cols-2' 
     : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

  return (
    <div className="flex flex-col h-full w-full bg-black relative overflow-hidden">
        
        {/* Header Overlay */}
        <div className="absolute top-0 left-0 right-0 p-4 z-20 flex justify-between items-start bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
             <div className="pointer-events-auto">
                 <h2 className="text-white font-bold text-lg flex items-center gap-2">
                     <Volume2 className="text-green-400" /> {channelName}
                 </h2>
                 <span className="text-white/60 text-sm">{Object.keys(peers).length + 1} connected</span>
             </div>
             <div className="pointer-events-auto flex gap-2">
                 <button onClick={onToggleMinimize} className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white backdrop-blur-md">
                     <Minimize2 size={20} />
                 </button>
             </div>
        </div>

        {/* Main Grid */}
        <div className={`flex-1 p-4 grid ${gridClass} gap-4 overflow-y-auto`}>
            {allParticipants.map(p => (
                <VideoTile key={p.peerId} peer={p} isLocal={p.peerId === 'local'} />
            ))}
        </div>

        {/* Control Bar */}
        <div className="h-20 bg-[rgb(var(--color-surface))] border-t border-[rgb(var(--color-border))] flex items-center justify-center gap-4 z-20 shadow-2xl px-4 shrink-0">
            <button 
                onClick={toggleMic}
                className={`p-4 rounded-full transition-all duration-200 ${isMicOn ? 'bg-[rgb(var(--color-surface-hover))] text-[rgb(var(--color-text))]' : 'bg-red-500 text-white shadow-lg shadow-red-500/30'}`}
            >
                {isMicOn ? <Mic size={24} /> : <MicOff size={24} />}
            </button>
            
            <button 
                onClick={toggleCamera}
                className={`p-4 rounded-full transition-all duration-200 ${isCameraOn ? 'bg-white text-black' : 'bg-[rgb(var(--color-surface-hover))] text-[rgb(var(--color-text))]'}`}
            >
                {isCameraOn ? <Video size={24} /> : <VideoOff size={24} />}
            </button>

            <button 
                onClick={toggleScreenShare}
                className={`p-4 rounded-full transition-all duration-200 ${isScreenSharing ? 'bg-green-500 text-white' : 'bg-[rgb(var(--color-surface-hover))] text-[rgb(var(--color-text))]'}`}
                title="Share Screen"
            >
                <Monitor size={24} />
            </button>

            <button 
                onClick={onDisconnect}
                className="p-4 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg ml-4"
                title="Disconnect"
            >
                <PhoneOff size={24} />
            </button>
        </div>
    </div>
  );
};
