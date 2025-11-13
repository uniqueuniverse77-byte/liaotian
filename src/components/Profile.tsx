// src/components/Profile.tsx
import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase, Profile as ProfileType, Post, uploadMedia } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { BadgeCheck, Edit2, Check, MessageCircle, X, UserMinus, Paperclip, FileText, Settings as SettingsIcon, MoreVertical, Trash2, Camera, Crop, Heart, Link, Loader2, Send } from 'lucide-react';
import { RealtimeChannel } from '@supabase/supabase-js';

// --- Auxiliary Types (Copied from Feed.tsx) ---

interface Comment {
  id: string;
  content: string;
  created_at: string;
  user_id: string;
  profiles: {
    username: string;
    display_name: string;
    avatar_url: string;
    verified: boolean;
  };
}

interface Liker {
  user_id: string;
  profiles: {
    username: string;
    display_name: string;
    avatar_url: string;
    verified: boolean;
  };
}

// Define the type for the crop result, simplifying for this context
type CropResult = {
  blob: Blob;
  fileName: string;
  fileType: string;
};

// --- START: CROP UTILITY FUNCTIONS (In a real app, these would be in a separate utility file) ---

/**
 * Uses HTML Canvas to perform a center-crop on an image and returns the result as a Blob.
 * The 'scale' parameter simulates zooming into the image's center point.
 * @param imageFile The File object (image) to crop.
 * @param type 'avatar' (1:1 aspect) or 'banner' (~2.5:1 aspect).
 * @param scale The zoom factor (1.0 = no zoom).
 * @returns A Promise that resolves to the cropped Blob or null on failure.
 */
const getCroppedImageBlob = (imageFile: File, type: 'avatar' | 'banner', scale: number): Promise<Blob | null> => {
  return new Promise((resolve) => {
    const image = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      image.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);

        const imgWidth = image.naturalWidth;
        const imgHeight = image.naturalHeight;

        // Calculate target dimensions and position for a center crop
        let targetWidth, targetHeight;
        if (type === 'avatar') {
          // Square crop (1:1)
          targetWidth = targetHeight = Math.min(imgWidth, imgHeight);
        } else {
          // Banner crop (~2.5:1 aspect ratio, keeping aspect based on width)
          targetWidth = imgWidth;
          targetHeight = imgWidth / 2.5;
          if (targetHeight > imgHeight) { // If banner height exceeds actual image height
            targetHeight = imgHeight;
            targetWidth = targetHeight * 2.5;
          }
        }

        // Apply scale/zoom effect
        const scaledWidth = targetWidth / scale;
        const scaledHeight = targetHeight / scale;

        // Calculate coordinates to center the scaled crop area
        const sx = (imgWidth - scaledWidth) / 2;
        const sy = (imgHeight - scaledHeight) / 2;

        // Set canvas size to the final output size (1:1 or 2.5:1 ratio)
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        // Draw the image onto the canvas, performing the crop and scale
        ctx.drawImage(
          image,
          sx,
          sy,
          scaledWidth,
          scaledHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );

        canvas.toBlob((blob) => {
          resolve(blob);
        }, imageFile.type);
      };
      image.src = e.target?.result as string;
    };
    reader.readAsDataURL(imageFile);
  });
};
// --- END: CROP UTILITY FUNCTIONS ---

const POSTS_PER_PAGE = 10;
const ENABLE_REALTIME_SUBSCRIPTION = false;

// --- Helper Functions for Social Features ---

const formatTime = (timestamp: string) => {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const truncateUrl = (url: string, maxLength: number = 30): string => {
  try {
    const withoutProtocol = url.replace(/^(https?:\/\/)/, '');
    if (withoutProtocol.length <= maxLength) {
      return withoutProtocol;
    }
    const parts = withoutProtocol.split('/');
    if (parts.length > 1 && withoutProtocol.includes('.')) {
      // Show domain and first part of the path
      const domain = parts[0];
      // Find the first path segment that is not just a query string/fragment
      const pathPart = parts.slice(1).find(p => p.length > 0) || '';
      
      if (domain.length + 5 + pathPart.length < maxLength) {
        return `${domain}/${pathPart}...`;
      }
      
      // Simple truncation for very long URLs
      return `${domain}/...${withoutProtocol.slice(-10)}`;
    }
    // Simple truncation for long domains
    return `${withoutProtocol.substring(0, maxLength - 3)}...`;
  } catch (e) {
    return url;
  }
};

const normalizeUrl = (url: string) => {
    if (!url.match(/^(https?:\/\/)/i)) {
        return `https://${url}`;
    }
    return url;
};


export const Profile = ({ profileUsername }: { profileUsername: string | null }) => {
  const { user, profile: myProfile } = useAuth();
  const [profile, setProfile] = useState<ProfileType | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followCount, setFollowCount] = useState({ followers: 0, following: 0 });
  const [isEditing, setIsEditing] = useState(false);
  const [editProfileForm, setEditProfileForm] = useState({
    display_name: '',
    bio: '',
    bio_link: '', // NEW: bio_link state
    username: ''
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFollowersModal, setShowFollowersModal] = useState(false);
  const [showFollowingModal, setShowFollowingModal] = useState(false);
  const [followList, setFollowList] = useState<ProfileType[]>([]);
  const [page, setPage] = useState(0);
  const [hasMorePosts, setHasMorePosts] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Social Features State (Copied from Feed.tsx)
  const [likedPostIds, setLikedPostIds] = useState<Set<string>>(new Set());
  const [activeLikesModal, setActiveLikesModal] = useState<string | null>(null);
  const [likersList, setLikersList] = useState<Liker[]>([]);
  const [activeCommentsModal, setActiveCommentsModal] = useState<string | null>(null);
  const [commentsList, setCommentsList] = useState<Comment[]>([]);
  const [newCommentText, setNewCommentText] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);

  // Lightbox State
  const [showLightbox, setShowLightbox] = useState(false);
  const [lightboxMediaUrl, setLightboxMediaUrl] = useState('');
  const [lightboxMediaType, setLightboxMediaType] = useState<'image' | 'video' | null>(null);

  // Cropper State
  const [showCropModal, setShowCropModal] = useState(false);
  const [imageToCrop, setImageToCrop] = useState<{ file: File, type: 'avatar' | 'banner' } | null>(null);
  const [cropScale, setCropScale] = useState(1.0);
  const [isUploadingCrop, setIsUploadingCrop] = useState(false);

  const openLightbox = (url: string, type: 'image' | 'video') => {
    setLightboxMediaUrl(url);
    setLightboxMediaType(type);
    setShowLightbox(true);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);


  // --- Social Feature Logic (Adapted from Feed.tsx) ---

  const fetchUserLikes = useCallback(async (currentPosts: Post[]) => {
    if (!user || currentPosts.length === 0) return;
    const postIds = currentPosts.map(p => p.id);
    const { data } = await supabase
      .from('likes')
      .select('entity_id')
      .eq('user_id', user.id)
      .eq('entity_type', 'post')
      .in('entity_id', postIds);
    
    if (data) {
      setLikedPostIds(prev => {
        const newSet = new Set(prev);
        data.forEach(d => newSet.add(d.entity_id));
        return newSet;
      });
    }
  }, [user]);

  const handleToggleLike = async (post: Post) => {
    if (!user) return;
    const isLiked = likedPostIds.has(post.id);
    
    // Optimistic Update
    const newSet = new Set(likedPostIds);
    if (isLiked) newSet.delete(post.id);
    else newSet.add(post.id);
    setLikedPostIds(newSet);

    setPosts(current => current.map(p => {
      if (p.id === post.id) {
        return { ...p, like_count: isLiked ? (p.like_count - 1) : (p.like_count + 1) };
      }
      return p;
    }));

    // DB Update
    if (isLiked) {
      await supabase.from('likes').delete().match({ user_id: user.id, entity_id: post.id, entity_type: 'post' });
    } else {
      await supabase.from('likes').insert({ user_id: user.id, entity_id: post.id, entity_type: 'post' });
    }
  };

  const openLikesList = async (postId: string) => {
    setActiveLikesModal(postId);
    const { data } = await supabase
      .from('likes')
      .select('user_id, profiles(*)')
      .eq('entity_id', postId)
      .eq('entity_type', 'post');
    if (data) setLikersList(data as unknown as Liker[]);
  };

  const openCommentsList = async (postId: string) => {
    setActiveCommentsModal(postId);
    const { data } = await supabase
      .from('comments')
      .select('*, profiles(*)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (data) setCommentsList(data as Comment[]);
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !activeCommentsModal || !newCommentText.trim()) return;
    
    setIsPostingComment(true);
    const postId = activeCommentsModal;

    const { data, error } = await supabase
      .from('comments')
      .insert({
        post_id: postId,
        user_id: user.id,
        content: newCommentText.trim()
      })
      .select('*, profiles(*)')
      .single();

    if (!error && data) {
      setCommentsList(prev => [...prev, data as Comment]);
      setNewCommentText('');
      // Update post comment count in feed optimistically
      setPosts(current => current.map(p => {
        if (p.id === postId) return { ...p, comment_count: (p.comment_count || 0) + 1 };
        return p;
      }));
    }
    setIsPostingComment(false);
  };
  // --- END Social Feature Logic ---

  const fetchProfile = useCallback(async (username: string) => {
    setIsLoadingProfile(true);
    try {
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username)
        .single();

      if (profileError || !profileData) {
        setError("Profile not found or inaccessible.");
        setProfile(null);
        return;
      }

      setProfile(profileData);
      setEditProfileForm({
        display_name: profileData.display_name,
        bio: profileData.bio || '',
        username: profileData.username,
        bio_link: profileData.bio_link || '' // Initialize new field
      });

      // Fetch follow status
      if (user && user.id !== profileData.id) {
        const { count } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('follower_id', user.id)
          .eq('following_id', profileData.id);
        setIsFollowing(count! > 0);
      } else {
        setIsFollowing(false);
      }

      // Fetch counts
      const { count: followers } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('following_id', profileData.id);
      
      const { count: following } = await supabase
        .from('follows')
        .select('*', { count: 'exact', head: true })
        .eq('follower_id', profileData.id);

      setFollowCount({ followers: followers || 0, following: following || 0 });

    } catch (e) {
      console.error(e);
      setError("An unexpected error occurred.");
    } finally {
      setIsLoadingProfile(false);
    }
  }, [user]);

  const loadPosts = useCallback(async (pageIndex: number) => {
    if (isLoadingMore || !profile) return;
    setIsLoadingMore(true);

    const from = pageIndex * POSTS_PER_PAGE;
    const to = from + POSTS_PER_PAGE - 1;

    const { data } = await supabase
      .from('posts')
      .select('*, profiles(*)')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .range(from, to);

    const newPosts = data || [];

    setPosts(current => pageIndex === 0 ? newPosts : [...current, ...newPosts]);
    setHasMorePosts(newPosts.length === POSTS_PER_PAGE);
    setPage(pageIndex);
    
    // Fetch likes for newly loaded posts
    fetchUserLikes(newPosts);
    
    setIsLoadingMore(false);
  }, [isLoadingMore, profile, fetchUserLikes]);

  useEffect(() => {
    if (profileUsername) {
      fetchProfile(profileUsername);
      setPage(0); // Reset pagination
      setPosts([]); // Clear posts
      setHasMorePosts(true);
    } else {
      // Logic for showing current user's profile if no username is provided
      if (myProfile) {
        fetchProfile(myProfile.username);
      }
    }
  }, [profileUsername, myProfile, fetchProfile]);

  useEffect(() => {
    if (profile) {
      loadPosts(0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]); // Only refetch posts when profile ID changes

  useEffect(() => {
    let channel: RealtimeChannel | undefined;
    if (profile && ENABLE_REALTIME_SUBSCRIPTION) {
      channel = supabase.channel(`profile:${profile.id}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts', filter: `user_id=eq.${profile.id}` }, async (payload) => {
        const { data } = await supabase.from('posts').select('*, profiles(*)').eq('id', payload.new.id).single();
        if (data) setPosts(current => [data, ...current]);
      }).subscribe();
    }
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [profile]);

  const handleScroll = () => {
    const scrollContainer = document.documentElement;
    const isAtBottom = window.innerHeight + window.scrollY >= scrollContainer.offsetHeight - 50;

    if (isAtBottom && hasMorePosts && !isLoadingMore) {
      loadPosts(page + 1);
    }
  };

  useEffect(() => {
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [hasMorePosts, isLoadingMore, page, loadPosts]);

  const handleFollowToggle = async () => {
    if (!user || !profile || user.id === profile.id) return;
    
    if (isFollowing) {
      // Unfollow
      await supabase.from('follows').delete().match({ follower_id: user.id, following_id: profile.id });
      setIsFollowing(false);
      setFollowCount(c => ({ ...c, followers: c.followers - 1 }));
    } else {
      // Follow
      await supabase.from('follows').insert({ follower_id: user.id, following_id: profile.id });
      setIsFollowing(true);
      setFollowCount(c => ({ ...c, followers: c.followers + 1 }));
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || isSaving) return;

    setIsSaving(true);
    setError(null);

    const { username, display_name, bio, bio_link } = editProfileForm;

    // Basic validation
    if (!username.match(/^[a-zA-Z0-9_]{3,15}$/)) {
      setError("Username must be 3-15 alphanumeric characters or underscores.");
      setIsSaving(false);
      return;
    }

    if (username !== profile.username) {
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('username', username);
      if (count! > 0) {
        setError("This username is already taken.");
        setIsSaving(false);
        return;
      }
    }
    
    // Normalize bio_link if present
    const normalizedBioLink = bio_link ? normalizeUrl(bio_link) : null;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ 
        username, 
        display_name, 
        bio: bio.trim(), 
        bio_link: normalizedBioLink // Save the new field
      })
      .eq('id', profile.id);

    if (updateError) {
      setError(updateError.message);
    } else {
      // Update local state and URL
      setProfile(current => current ? { ...current, ...editProfileForm, bio_link: normalizedBioLink } : null);
      if (username !== profileUsername) {
        window.history.replaceState({}, '', `/?${username}`);
      }
      setIsEditing(false);
    }
    setIsSaving(false);
  };
  
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'avatar' | 'banner') => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      setImageToCrop({ file, type });
      setShowCropModal(true);
    }
  };

  const handleCropAndUpload = async () => {
    if (!imageToCrop || !profile) return;
    
    setIsUploadingCrop(true);
    const { file, type } = imageToCrop;
    
    const blob = await getCroppedImageBlob(file, type, cropScale);
    
    if (!blob) {
      setIsUploadingCrop(false);
      return;
    }
    
    // Create a new File object from the blob for the upload utility
    const croppedFile = new File([blob], file.name, { type: blob.type });

    const result = await uploadMedia(croppedFile, 'avatars', () => {}); // No progress tracking for small images

    if (result) {
      const updateField = type === 'avatar' ? 'avatar_url' : 'banner_url';
      
      await supabase
        .from('profiles')
        .update({ [updateField]: result.url })
        .eq('id', profile.id);
      
      setProfile(p => p ? { ...p, [updateField]: result.url } : null);
    }
    
    setIsUploadingCrop(false);
    setShowCropModal(false);
    setImageToCrop(null);
    setCropScale(1.0);
  };


  const openFollowModal = async (type: 'followers' | 'following') => {
    const isFollowers = type === 'followers';
    
    const selectQuery = isFollowers ? 'follower_id!inner(profiles(*))' : 'following_id!inner(profiles(*))';
    const matchField = isFollowers ? 'following_id' : 'follower_id';
    
    const { data } = await supabase
      .from('follows')
      .select(selectQuery)
      .eq(matchField, profile!.id);

    const list: ProfileType[] = (data || []).map((item: any) => 
        isFollowers ? item.follower_id.profiles : item.following_id.profiles
    );

    setFollowList(list.filter(p => p !== null));
    if (isFollowers) {
      setShowFollowersModal(true);
    } else {
      setShowFollowingModal(true);
    }
  };

  const goToProfile = async (profileId: string) => {
    // Close modals if open
    setActiveLikesModal(null);
    setActiveCommentsModal(null);
    setShowFollowersModal(false);
    setShowFollowingModal(false);

    const { data } = await supabase.from('profiles').select('username').eq('id', profileId).single();
    if (data) {
      window.history.replaceState({}, '', `/?${data.username}`);
      window.dispatchEvent(new CustomEvent('navigateToProfile', { detail: profileId }));
    }
  };

  if (isLoadingProfile) {
    return (
      <div className="flex justify-center items-center py-16">
        <Loader2 size={32} className="animate-spin text-[rgb(var(--color-accent))]" />
      </div>
    );
  }

  if (error || !profile) {
    return <div className="text-center py-16 text-red-500">{error || "Profile data missing."}</div>;
  }

  return (
    <div className="max-w-2xl mx-auto pb-24">
      {/* Banner */}
      <div className="relative h-40 bg-[rgb(var(--color-border))] overflow-hidden">
        {profile.banner_url && (
          <img src={profile.banner_url} className="w-full h-full object-cover" alt="Banner" />
        )}
        {profile.id === user?.id && (
          <div className="absolute top-2 right-2">
            <input
              type="file"
              ref={bannerInputRef}
              accept="image/*"
              className="hidden"
              onChange={(e) => handleFileUpload(e, 'banner')}
            />
            <button
              onClick={() => bannerInputRef.current?.click()}
              className="p-2 bg-black/50 text-white rounded-full hover:bg-black/70 transition backdrop-blur-sm"
            >
              <Camera size={20} />
            </button>
          </div>
        )}
      </div>
      
      <div className="p-4 relative">
        {/* Avatar */}
        <div className="absolute -top-16 left-4">
          <div className="relative w-32 h-32 rounded-full border-4 border-[rgb(var(--color-surface))] bg-[rgb(var(--color-surface))] overflow-hidden">
            <img 
              src={profile.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${profile.username}`} 
              className="w-full h-full object-cover" 
              alt="Avatar" 
            />
            {profile.id === user?.id && (
              <>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFileUpload(e, 'avatar')}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-0 flex items-center justify-center bg-black/30 text-white opacity-0 hover:opacity-100 transition"
                >
                  <Camera size={24} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Action/Edit Buttons */}
        <div className="flex justify-end mt-2">
          {profile.id === user?.id ? (
            <button
              onClick={() => setIsEditing(true)}
              className="flex items-center gap-1.5 px-4 py-2 border border-[rgb(var(--color-border))] rounded-full font-semibold text-sm hover:bg-[rgb(var(--color-surface-hover))] transition text-[rgb(var(--color-text))]"
            >
              <Edit2 size={16} /> Edit Profile
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleFollowToggle}
                className={`px-4 py-2 rounded-full font-semibold text-sm transition ${
                  isFollowing
                    ? 'bg-[rgb(var(--color-surface))] border border-[rgb(var(--color-border))] text-[rgb(var(--color-text))] hover:bg-red-500/10 hover:text-red-500 group'
                    : 'bg-[rgb(var(--color-accent))] text-[rgb(var(--color-text-on-primary))] hover:bg-[rgba(var(--color-primary),1)]'
                }`}
              >
                {isFollowing ? (
                  <span className="group-hover:hidden">Following</span>
                ) : (
                  'Follow'
                )}
                {isFollowing && (
                  <span className="hidden group-hover:inline-flex items-center gap-1">
                    <UserMinus size={14} /> Unfollow
                  </span>
                )}
              </button>
            </div>
          )}
        </div>
        
        {/* Profile Info */}
        <div className="mt-8">
          <h1 className="flex items-center gap-2 text-xl font-bold text-[rgb(var(--color-text))]">
            {profile.display_name}
            {profile.verified && <BadgeCheck size={20} className="text-[rgb(var(--color-accent))]" />}
          </h1>
          <p className="text-[rgb(var(--color-text-secondary))]">@{profile.username}</p>
          <p className="mt-2 whitespace-pre-wrap text-[rgb(var(--color-text))]">{profile.bio}</p>

          <div className="flex items-center gap-4 mt-2 text-sm text-[rgb(var(--color-text-secondary))] flex-wrap">
            <button onClick={() => openFollowModal('following')} className="hover:underline font-semibold">
              <span className="font-bold text-[rgb(var(--color-text))]">{followCount.following}</span> Following
            </button>
            <button onClick={() => openFollowModal('followers')} className="hover:underline font-semibold">
              <span className="font-bold text-[rgb(var(--color-text))]">{followCount.followers}</span> Followers
            </button>
            {/* NEW: Bio Link Display */}
            {profile.bio_link && (
              <a 
                href={normalizeUrl(profile.bio_link)} 
                target="_blank" 
                rel="noopener noreferrer" 
                className="flex items-center gap-1 text-[rgb(var(--color-accent))] hover:underline"
              >
                <Link size={14} />
                <span className="truncate max-w-[150px] sm:max-w-none">{truncateUrl(profile.bio_link)}</span>
              </a>
            )}
          </div>
        </div>
        
        {/* Posts */}
        <div className="mt-6 border-t border-[rgb(var(--color-border))]">
          {posts.map((post) => (
            <div key={post.id} className="border-b border-[rgb(var(--color-border))] p-4 hover:bg-[rgb(var(--color-surface-hover))] transition bg-[rgb(var(--color-surface))]" >
              <div className="flex gap-4 items-start">
                <div className="flex-shrink-0 relative">
                  <img
                    src={post.profiles?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${post.profiles?.username}`}
                    className="w-12 h-12 rounded-full"
                    alt="Avatar"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="font-bold text-[rgb(var(--color-text))]">
                      {post.profiles?.display_name}
                    </span>
                    {post.profiles?.verified && <BadgeCheck size={16} className="text-[rgb(var(--color-accent))]" />}
                    <span className="text-[rgb(var(--color-text-secondary))] text-sm">@{post.profiles?.username}</span>
                    <span className="text-[rgb(var(--color-text-secondary))] text-sm">· {new Date(post.created_at).toLocaleDateString()} at {formatTime(post.created_at)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[rgb(var(--color-text))]" >{post.content}</p>
                  
                  {post.media_url && (
                    <div className="mt-3">
                      {post.media_type === 'image' && (
                        <img 
                          src={post.media_url} 
                          className="rounded-2xl max-h-96 object-cover w-full cursor-pointer transition hover:opacity-90" 
                          alt="Post" 
                          onClick={() => openLightbox(post.media_url, 'image')}
                        />
                      )}
                      {post.media_type === 'video' && (
                        <video controls className="rounded-2xl max-h-96 w-full">
                          <source src={post.media_url} />
                          Your browser does not support the video tag.
                        </video>
                      )}
                      {post.media_type === 'document' && (
                        <a
                          href={post.media_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 p-3 bg-[rgb(var(--color-surface-hover))] rounded-lg hover:bg-[rgb(var(--color-border))] transition inline-block text-[rgb(var(--color-text))]" 
                        >
                          <FileText size={20} className="text-[rgb(var(--color-text-secondary))]" /> Download File
                        </a>
                      )}
                    </div>
                  )}

                  {/* Action Bar (Likes and Comments) */}
                  <div className="flex items-center gap-6 mt-3">
                    <div className="flex items-center gap-1 group">
                      <button 
                        onClick={(e) => { e.stopPropagation(); handleToggleLike(post); }}
                        className={`p-2 rounded-full transition ${
                          likedPostIds.has(post.id) 
                            ? 'text-pink-500 bg-pink-500/10' 
                            : 'text-[rgb(var(--color-text-secondary))] hover:bg-pink-500/10 hover:text-pink-500'
                        }`}
                      >
                        <Heart size={18} fill={likedPostIds.has(post.id) ? "currentColor" : "none"} />
                      </button>
                      {(post.like_count > 0) && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); openLikesList(post.id); }}
                          className="text-sm text-[rgb(var(--color-text-secondary))] hover:underline"
                        >
                          {post.like_count}
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-1 group">
                      <button 
                        onClick={(e) => { e.stopPropagation(); openCommentsList(post.id); }}
                        className="p-2 rounded-full transition text-[rgb(var(--color-text-secondary))] hover:bg-blue-500/10 hover:text-blue-500"
                      >
                        <MessageCircle size={18} />
                      </button>
                      {(post.comment_count > 0) && (
                        <button 
                          onClick={(e) => { e.stopPropagation(); openCommentsList(post.id); }}
                          className="text-sm text-[rgb(var(--color-text-secondary))] hover:underline"
                        >
                          {post.comment_count}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {isLoadingMore && (
            <div className="flex justify-center items-center py-4">
              <Loader2 size={24} className="animate-spin text-[rgb(var(--color-accent))]" />
            </div>
          )}

          {!hasMorePosts && posts.length > 0 && (
            <div className="text-center py-8 text-[rgb(var(--color-text-secondary))]">
              End of posts.
            </div>
          )}
        </div>
      </div>

      {/* --- Modals --- */}
      
      {/* Edit Profile Modal */}
      {isEditing && (
        <div 
          className="fixed inset-0 bg-black/60 z-[90] flex items-center justify-center p-4"
          onClick={() => { if (!isSaving) setIsEditing(false); }}
        >
          <form 
            onSubmit={handleSaveProfile}
            className="bg-[rgb(var(--color-surface))] w-full max-w-md rounded-2xl flex flex-col shadow-2xl border border-[rgb(var(--color-border))]" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[rgb(var(--color-border))] flex items-center justify-between">
              <h3 className="font-bold text-lg text-[rgb(var(--color-text))]">Edit Profile</h3>
              <button 
                type="button" 
                onClick={() => setIsEditing(false)} 
                disabled={isSaving}
                className="p-1 hover:bg-[rgb(var(--color-surface-hover))] rounded-full"
              >
                <X size={20} className="text-[rgb(var(--color-text))]" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="space-y-1">
                <label htmlFor="display_name" className="text-sm font-semibold text-[rgb(var(--color-text))]">Display Name</label>
                <input
                  id="display_name"
                  type="text"
                  value={editProfileForm.display_name}
                  onChange={(e) => setEditProfileForm(f => ({ ...f, display_name: e.target.value }))}
                  className="w-full px-3 py-2 border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] rounded-lg focus:outline-none focus:border-[rgb(var(--color-accent))] text-[rgb(var(--color-text))]"
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="username" className="text-sm font-semibold text-[rgb(var(--color-text))]">Username</label>
                <input
                  id="username"
                  type="text"
                  value={editProfileForm.username}
                  onChange={(e) => setEditProfileForm(f => ({ ...f, username: e.target.value.toLowerCase() }))}
                  className="w-full px-3 py-2 border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] rounded-lg focus:outline-none focus:border-[rgb(var(--color-accent))] text-[rgb(var(--color-text))]"
                  required
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="bio" className="text-sm font-semibold text-[rgb(var(--color-text))]">Bio</label>
                <textarea
                  id="bio"
                  value={editProfileForm.bio}
                  onChange={(e) => setEditProfileForm(f => ({ ...f, bio: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] rounded-lg focus:outline-none focus:border-[rgb(var(--color-accent))] resize-none text-[rgb(var(--color-text))]"
                />
              </div>
              {/* NEW: Bio Link Input */}
              <div className="space-y-1">
                <label htmlFor="bio_link" className="text-sm font-semibold text-[rgb(var(--color-text))]">Bio Link (URL)</label>
                <input
                  id="bio_link"
                  type="url"
                  placeholder="https://yourwebsite.com"
                  value={editProfileForm.bio_link}
                  onChange={(e) => setEditProfileForm(f => ({ ...f, bio_link: e.target.value }))}
                  className="w-full px-3 py-2 border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] rounded-lg focus:outline-none focus:border-[rgb(var(--color-accent))] text-[rgb(var(--color-text))]"
                />
              </div>
              {error && <p className="text-red-500 text-sm">{error}</p>}
            </div>
            <div className="p-4 border-t border-[rgb(var(--color-border))] flex justify-end">
              <button
                type="submit"
                disabled={isSaving}
                className="flex items-center gap-2 bg-[rgb(var(--color-accent))] disabled:bg-[rgb(var(--color-border))] disabled:text-[rgb(var(--color-text-secondary))] text-[rgb(var(--color-text-on-primary))] px-6 py-2 rounded-full hover:bg-[rgba(var(--color-primary),1)] font-semibold transition"
              >
                {isSaving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Followers/Following Modal */}
      {(showFollowersModal || showFollowingModal) && (
        <div 
          className="fixed inset-0 bg-black/60 z-[90] flex items-center justify-center p-4"
          onClick={() => { setShowFollowersModal(false); setShowFollowingModal(false); }}
        >
          <div 
            className="bg-[rgb(var(--color-surface))] w-full max-w-md rounded-2xl max-h-[70vh] flex flex-col shadow-2xl border border-[rgb(var(--color-border))]" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[rgb(var(--color-border))] flex items-center justify-between">
              <h3 className="font-bold text-lg text-[rgb(var(--color-text))]">{showFollowersModal ? 'Followers' : 'Following'}</h3>
              <button 
                onClick={() => { setShowFollowersModal(false); setShowFollowingModal(false); }} 
                className="p-1 hover:bg-[rgb(var(--color-surface-hover))] rounded-full"
              >
                <X size={20} className="text-[rgb(var(--color-text))]" />
              </button>
            </div>
            <div className="overflow-y-auto p-4 space-y-4">
              {followList.map(item => {
                const isCurrentUser = user && item.id === user.id;
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <img 
                      src={item.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${item.username}`}
                      className="w-10 h-10 rounded-full cursor-pointer"
                      alt="Avatar"
                      onClick={() => goToProfile(item.id)}
                    />
                    <div className="flex-1">
                      <button onClick={() => goToProfile(item.id)} className="font-bold hover:underline text-[rgb(var(--color-text))] text-sm block">
                        {item.display_name}
                        {item.verified && <BadgeCheck size={14} className="inline ml-1 text-[rgb(var(--color-accent))]" />}
                      </button>
                      <span className="text-sm text-[rgb(var(--color-text-secondary))]">@{item.username}</span>
                    </div>
                    {!isCurrentUser && (
                      <div className="flex-shrink-0">
                        {/* Simplified follow button in modal - full logic would be complex */}
                        <button
                          // onClick={() => { /* In a real app, this would toggle follow and update counts */ }}
                          className="px-3 py-1 text-xs border border-[rgb(var(--color-border))] rounded-full font-semibold text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-surface-hover))] transition"
                        >
                          View
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Likes Modal (Copied from Feed.tsx) */}
      {activeLikesModal && (
        <div 
          className="fixed inset-0 bg-black/60 z-[90] flex items-center justify-center p-4"
          onClick={() => setActiveLikesModal(null)}
        >
          <div 
            className="bg-[rgb(var(--color-surface))] w-full max-w-md rounded-2xl max-h-[70vh] flex flex-col shadow-2xl border border-[rgb(var(--color-border))]" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[rgb(var(--color-border))] flex items-center justify-between">
              <h3 className="font-bold text-lg text-[rgb(var(--color-text))]">Likes</h3>
              <button onClick={() => setActiveLikesModal(null)} className="p-1 hover:bg-[rgb(var(--color-surface-hover))] rounded-full">
                <X size={20} className="text-[rgb(var(--color-text))]" />
              </button>
            </div>
            <div className="overflow-y-auto p-4 space-y-4">
              {likersList.length === 0 ? (
                 <p className="text-center text-[rgb(var(--color-text-secondary))]">No likes yet.</p>
              ) : (
                likersList.map((liker, idx) => (
                  <div key={`${liker.user_id}-${idx}`} className="flex items-center gap-3">
                    <img 
                       src={liker.profiles?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${liker.profiles?.username}`}
                       className="w-10 h-10 rounded-full cursor-pointer"
                       alt="Avatar"
                       onClick={() => goToProfile(liker.user_id)}
                    />
                    <div className="flex-1">
                      <button onClick={() => goToProfile(liker.user_id)} className="font-bold hover:underline text-[rgb(var(--color-text))] text-sm block">
                        {liker.profiles?.display_name}
                        {liker.profiles?.verified && <BadgeCheck size={14} className="inline ml-1 text-[rgb(var(--color-accent))]" />}
                      </button>
                      <span className="text-sm text-[rgb(var(--color-text-secondary))]">@{liker.profiles?.username}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Comments Modal (Copied from Feed.tsx) */}
      {activeCommentsModal && (
        <div 
          className="fixed inset-0 bg-black/60 z-[90] flex items-center justify-center p-4"
          onClick={() => setActiveCommentsModal(null)}
        >
          <div 
            className="bg-[rgb(var(--color-surface))] w-full max-w-lg rounded-2xl h-[80vh] flex flex-col shadow-2xl border border-[rgb(var(--color-border))]" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[rgb(var(--color-border))] flex items-center justify-between">
              <h3 className="font-bold text-lg text-[rgb(var(--color-text))]">Comments</h3>
              <button onClick={() => setActiveCommentsModal(null)} className="p-1 hover:bg-[rgb(var(--color-surface-hover))] rounded-full">
                <X size={20} className="text-[rgb(var(--color-text))]" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {commentsList.length === 0 ? (
                 <div className="h-full flex items-center justify-center">
                   <p className="text-[rgb(var(--color-text-secondary))]">No comments yet. Be the first!</p>
                 </div>
              ) : (
                commentsList.map((comment) => (
                  <div key={comment.id} className="flex gap-3">
                    <img 
                       src={comment.profiles?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${comment.profiles?.username}`}
                       className="w-9 h-9 rounded-full cursor-pointer flex-shrink-0"
                       alt="Avatar"
                       onClick={() => goToProfile(comment.user_id)}
                    />
                    <div className="flex-1">
                      <div className="flex items-baseline gap-2">
                        <button onClick={() => goToProfile(comment.user_id)} className="font-bold hover:underline text-[rgb(var(--color-text))] text-sm">
                          {comment.profiles?.display_name}
                        </button>
                        {comment.profiles?.verified && <BadgeCheck size={12} className="text-[rgb(var(--color-accent))]" />}
                        <span className="text-xs text-[rgb(var(--color-text-secondary))]">{formatTime(comment.created_at)}</span>
                      </div>
                      <p className="text-[rgb(var(--color-text))] text-sm mt-0.5 whitespace-pre-wrap break-words bg-[rgb(var(--color-surface-hover))] p-2 rounded-r-xl rounded-bl-xl inline-block">
                        {comment.content}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handlePostComment} className="p-3 border-t border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] rounded-b-2xl">
              <div className="flex items-center gap-2 bg-[rgb(var(--color-surface-hover))] rounded-full px-4 py-2">
                <input
                  type="text"
                  value={newCommentText}
                  onChange={(e) => setNewCommentText(e.target.value)}
                  placeholder="Add a comment..."
                  className="flex-1 bg-transparent border-none outline-none text-sm text-[rgb(var(--color-text))]"
                  autoFocus
                />
                <button 
                  type="submit" 
                  disabled={!newCommentText.trim() || isPostingComment}
                  className="text-[rgb(var(--color-accent))] disabled:opacity-50 hover:text-[rgb(var(--color-primary))] transition"
                >
                  <Send size={18} />
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {showLightbox && lightboxMediaUrl && (
        <div 
          className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setShowLightbox(false)}
        >
          <div className="max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
            {lightboxMediaType === 'image' && (
              <img 
                src={lightboxMediaUrl} 
                className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl" 
                alt="Full size view"
              />
            )}
            {lightboxMediaType === 'video' && (
              <video 
                controls 
                autoPlay
                className="max-w-full max-h-[90vh] rounded-2xl"
              >
                <source src={lightboxMediaUrl} />
                Your browser does not support the video tag.
              </video>
            )}
          </div>
          <button 
            onClick={() => setShowLightbox(false)}
            className="absolute top-4 right-4 p-2 bg-white/10 text-white rounded-full hover:bg-white/20 transition"
          >
            <X size={24} />
          </button>
        </div>
      )}

      {/* Crop Modal */}
      {showCropModal && imageToCrop && (
        <div 
          className="fixed inset-0 bg-black/60 z-[110] flex items-center justify-center p-4"
          onClick={() => { if (!isUploadingCrop) setShowCropModal(false); }}
        >
          <div 
            className="bg-[rgb(var(--color-surface))] w-full max-w-lg rounded-2xl flex flex-col shadow-2xl border border-[rgb(var(--color-border))]" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 border-b border-[rgb(var(--color-border))] flex items-center justify-between">
              <h3 className="font-bold text-lg text-[rgb(var(--color-text))]">Crop {imageToCrop.type}</h3>
              <button 
                type="button" 
                onClick={() => setShowCropModal(false)} 
                disabled={isUploadingCrop}
                className="p-1 hover:bg-[rgb(var(--color-surface-hover))] rounded-full"
              >
                <X size={20} className="text-[rgb(var(--color-text))]" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="w-full relative overflow-hidden bg-gray-100 flex justify-center items-center">
                {/* Simple preview of the image, the actual cropping is done by logic on canvas */}
                <img 
                  src={URL.createObjectURL(imageToCrop.file)} 
                  alt="Crop Preview" 
                  style={{ 
                    maxHeight: '40vh', 
                    objectFit: 'contain',
                    border: '1px dashed rgb(var(--color-accent))',
                  }}
                  className="w-full"
                />
              </div>
              
              <div className="space-y-1">
                <label className="text-sm font-semibold text-[rgb(var(--color-text))]">Zoom/Scale: {Math.round(cropScale * 100)}%</label>
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.05"
                  value={cropScale}
                  onChange={(e) => setCropScale(parseFloat(e.target.value))}
                  className="w-full h-2 bg-[rgb(var(--color-border))] rounded-lg appearance-none cursor-pointer"
                />
              </div>
              <p className="text-sm text-[rgb(var(--color-text-secondary))]">The image will be centered and cropped. Use the zoom slider to select the area.</p>

            </div>
            <div className="p-4 border-t border-[rgb(var(--color-border))] flex justify-end">
              <button
                type="button"
                onClick={handleCropAndUpload}
                disabled={isUploadingCrop}
                className="flex items-center gap-2 bg-[rgb(var(--color-accent))] disabled:bg-[rgb(var(--color-border))] disabled:text-[rgb(var(--color-text-secondary))] text-[rgb(var(--color-text-on-primary))] px-6 py-2 rounded-full hover:bg-[rgba(var(--color-primary),1)] font-semibold transition"
              >
                {isUploadingCrop ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Crop size={16} />
                )}
                {isUploadingCrop ? 'Uploading...' : `Crop & Upload ${imageToCrop.type}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
