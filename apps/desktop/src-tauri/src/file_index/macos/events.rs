use std::{
    ffi::{CStr, CString, OsStr, c_char, c_void},
    mem::MaybeUninit,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::Mutex,
};

use core_foundation_sys::{
    array::{CFArrayCreate, CFArrayRef, kCFTypeArrayCallBacks},
    base::{CFAllocatorRef, CFRelease},
    dictionary::{CFDictionaryGetValue, CFDictionaryRef},
    number::CFBooleanGetValue,
    string::{CFStringCreateWithBytes, CFStringGetCString, CFStringRef, kCFStringEncodingUTF8},
    uuid::{CFUUIDCreateString, CFUUIDRef},
};

use super::MacEvent;

const SINCE_NOW: u64 = u64::MAX;
const HISTORY_DONE: u32 = 0x10;
const ROOT_CHANGED: u32 = 0x20;
const MUST_SCAN_SUBDIRS: u32 = 0x01;
const LOST_HISTORY: u32 = 0x02 | 0x04;
const EVENT_IDS_WRAPPED: u32 = 0x08;
const RENAMED: u32 = 0x800;
const FILE_EVENTS: u32 = 0x10;
const WATCH_ROOT: u32 = 0x04;
const NO_DEFER: u32 = 0x02;
const MAX_PENDING_EVENTS: usize = 16_384;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Volume {
    pub id: String,
    pub event_store: String,
    pub device: u64,
    pub mount: PathBuf,
}

impl Volume {
    pub fn for_path(path: &Path, device: u64) -> Option<Self> {
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut stat = MaybeUninit::<libc::statfs>::uninit();
        // statfs initializes the entire output struct on success.
        if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
            return None;
        }
        let stat = unsafe { stat.assume_init() };
        if stat.f_flags & libc::MNT_LOCAL as u32 == 0
            || unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }.to_bytes() != b"apfs"
        {
            return None;
        }
        let mount = PathBuf::from(OsStr::from_bytes(
            unsafe { CStr::from_ptr(stat.f_mntonname.as_ptr()) }.to_bytes(),
        ));
        let id = internal_volume_id(stat.f_mntfromname.as_ptr())?;
        let event_store =
            unsafe { OwnedCf::new(FSEventsCopyUUIDForDevice(device as libc::dev_t)) }?;
        Some(Self {
            id,
            event_store: uuid_text(event_store.0)?,
            device,
            mount,
        })
    }

    fn relative_root(&self, path: &Path) -> Option<PathBuf> {
        if let Ok(relative) = path.strip_prefix(&self.mount) {
            return Some(relative.to_path_buf());
        }
        // The startup APFS data volume is presented at /Users through a system firmlink.
        if self.mount == Path::new("/System/Volumes/Data") {
            return path.strip_prefix("/").ok().map(Path::to_path_buf);
        }
        None
    }
}

pub(super) fn current_event_id() -> u64 {
    unsafe { FSEventsGetCurrentEventId() }
}

pub(super) struct Watcher {
    stream: *mut c_void,
    queue: *mut c_void,
    callback: Box<Callback>,
    started: bool,
}

struct Callback {
    root: PathBuf,
    relative_root: PathBuf,
    pending: Mutex<Pending>,
}

struct Pending {
    history_complete: bool,
    recovery: Recovery,
    events: Vec<MacEvent>,
}

#[derive(Default)]
pub(super) struct Recovery {
    pub rescan: bool,
    pub restart: bool,
    pub reset_cursor: bool,
}

impl Watcher {
    pub fn start(volume: &Volume, root: &Path, previous: Option<u64>) -> Option<Self> {
        let relative_root = volume.relative_root(root)?;
        let path = relative_root.to_str()?.as_bytes();
        let path_string = unsafe {
            OwnedCf::new(CFStringCreateWithBytes(
                null(),
                path.as_ptr(),
                path.len() as isize,
                kCFStringEncodingUTF8,
                0,
            ))
        }?;
        let array = unsafe {
            OwnedCf::new(CFArrayCreate(
                null(),
                &path_string.0.cast(),
                1,
                &raw const kCFTypeArrayCallBacks,
            ))
        }?;
        let since = previous.filter(|id| *id != 0);
        let mut callback = Box::new(Callback {
            root: root.to_path_buf(),
            relative_root,
            pending: Mutex::new(Pending {
                history_complete: since.is_none(),
                recovery: Recovery::default(),
                events: vec![],
            }),
        });
        let mut context = StreamContext {
            version: 0,
            info: (&mut *callback as *mut Callback).cast(),
            retain: None,
            release: None,
            describe: None,
        };
        // The callback stays boxed until Drop stops, invalidates, and drains its serial queue.
        let stream = unsafe {
            FSEventStreamCreateRelativeToDevice(
                null(),
                receive_events,
                &mut context,
                volume.device as libc::dev_t,
                array.0,
                since.unwrap_or(SINCE_NOW),
                0.25,
                NO_DEFER | WATCH_ROOT | FILE_EVENTS,
            )
        };
        if stream.is_null() {
            return None;
        }
        let queue =
            unsafe { dispatch_queue_create(c"com.qizhi.macos-file-index".as_ptr(), null()) };
        if queue.is_null() {
            unsafe { FSEventStreamRelease(stream) };
            return None;
        }
        unsafe { FSEventStreamSetDispatchQueue(stream, queue) };
        let started = unsafe { FSEventStreamStart(stream) } != 0;
        let watcher = Self {
            stream,
            queue,
            callback,
            started,
        };
        if !started {
            return None;
        }
        Some(watcher)
    }

    pub fn flush(&self) {
        unsafe { FSEventStreamFlushSync(self.stream) }
    }

    pub fn history_complete(&self) -> bool {
        self.callback
            .pending
            .lock()
            .is_ok_and(|pending| pending.history_complete || pending.recovery.rescan)
    }

    pub fn take(&self, through: u64, events: &mut Vec<MacEvent>) -> Recovery {
        let Ok(mut pending) = self.callback.pending.lock() else {
            return Recovery {
                rescan: true,
                restart: true,
                reset_cursor: false,
            };
        };
        let mut next = Vec::new();
        for event in pending.events.drain(..) {
            if event.id <= through {
                events.push(event);
            } else {
                next.push(event);
            }
        }
        pending.events = next;
        std::mem::take(&mut pending.recovery)
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        unsafe {
            if self.started {
                FSEventStreamStop(self.stream);
            }
            FSEventStreamInvalidate(self.stream);
            dispatch_sync_f(self.queue, null_mut(), queue_barrier);
            FSEventStreamRelease(self.stream);
            dispatch_release(self.queue);
        }
    }
}

unsafe extern "C" fn queue_barrier(_: *mut c_void) {}

unsafe extern "C" fn receive_events(
    _: *const c_void,
    info: *mut c_void,
    count: usize,
    paths: *mut c_void,
    flags: *const u32,
    ids: *const u64,
) {
    if count == 0 || info.is_null() || paths.is_null() || flags.is_null() || ids.is_null() {
        return;
    }
    // Without UseCFTypes the stream delivers parallel arrays and C-string paths for this callback.
    let callback = unsafe { &*info.cast::<Callback>() };
    let paths = unsafe { std::slice::from_raw_parts(paths.cast::<*const c_char>(), count) };
    let flags = unsafe { std::slice::from_raw_parts(flags, count) };
    let ids = unsafe { std::slice::from_raw_parts(ids, count) };
    let Ok(mut pending) = callback.pending.lock() else {
        return;
    };
    for ((&path, &flags), &id) in paths.iter().zip(flags).zip(ids) {
        if flags & HISTORY_DONE != 0 {
            pending.history_complete = true;
            continue;
        }
        if flags & (LOST_HISTORY | ROOT_CHANGED | EVENT_IDS_WRAPPED) != 0
            || pending.events.len() == MAX_PENDING_EVENTS
        {
            pending.recovery.rescan = true;
            pending.recovery.restart |= flags & (ROOT_CHANGED | EVENT_IDS_WRAPPED) != 0;
            pending.recovery.reset_cursor |= flags & EVENT_IDS_WRAPPED != 0;
            pending.events.clear();
            continue;
        }
        if path.is_null() {
            pending.recovery.rescan = true;
            continue;
        }
        let relative = Path::new(OsStr::from_bytes(
            unsafe { CStr::from_ptr(path) }.to_bytes(),
        ));
        let relative = relative.strip_prefix("/").unwrap_or(relative);
        let (absolute, observed_rename_ms) =
            if let Ok(suffix) = relative.strip_prefix(&callback.relative_root) {
                (
                    callback.root.join(suffix),
                    (pending.history_complete
                        && flags & RENAMED != 0
                        && flags & MUST_SCAN_SUBDIRS == 0)
                        .then(|| chrono::Utc::now().timestamp_millis()),
                )
            } else {
                // A coalesced ancestor event or a differently spelled recorded root needs a rescan.
                (callback.root.clone(), None)
            };
        pending.events.push(MacEvent {
            id,
            path: absolute,
            observed_rename_ms,
        });
    }
}

fn internal_volume_id(device_name: *const c_char) -> Option<String> {
    let session = unsafe { OwnedCf::new(DASessionCreate(null())) }?;
    let disk = unsafe { OwnedCf::new(DADiskCreateFromBSDName(null(), session.0, device_name)) }?;
    let description = unsafe { OwnedCf::new(DADiskCopyDescription(disk.0)) }?;
    let is_internal =
        unsafe { CFDictionaryGetValue(description.0, kDADiskDescriptionDeviceInternalKey.cast()) };
    if is_internal.is_null() || !unsafe { CFBooleanGetValue(is_internal.cast()) } {
        return None;
    }
    let uuid =
        unsafe { CFDictionaryGetValue(description.0, kDADiskDescriptionVolumeUUIDKey.cast()) };
    uuid_text(uuid.cast())
}

fn uuid_text(reference: CFUUIDRef) -> Option<String> {
    if reference.is_null() {
        return None;
    }
    let string = unsafe { OwnedCf::new(CFUUIDCreateString(null(), reference)) }?;
    let mut buffer = [0 as c_char; 37];
    if unsafe {
        CFStringGetCString(
            string.0,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            kCFStringEncodingUTF8,
        )
    } == 0
    {
        return None;
    }
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

struct OwnedCf<T>(*const T);

impl<T> OwnedCf<T> {
    unsafe fn new(pointer: *const T) -> Option<Self> {
        (!pointer.is_null()).then_some(Self(pointer))
    }
}

impl<T> Drop for OwnedCf<T> {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0.cast()) }
    }
}

type StreamCallback =
    unsafe extern "C" fn(*const c_void, *mut c_void, usize, *mut c_void, *const u32, *const u64);

#[repr(C)]
struct StreamContext {
    version: isize,
    info: *mut c_void,
    retain: Option<unsafe extern "C" fn(*const c_void) -> *const c_void>,
    release: Option<unsafe extern "C" fn(*const c_void)>,
    describe: Option<unsafe extern "C" fn(*const c_void) -> CFStringRef>,
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn FSEventsGetCurrentEventId() -> u64;
    fn FSEventsCopyUUIDForDevice(device: libc::dev_t) -> CFUUIDRef;
    fn FSEventStreamCreateRelativeToDevice(
        allocator: CFAllocatorRef,
        callback: StreamCallback,
        context: *mut StreamContext,
        device: libc::dev_t,
        paths: CFArrayRef,
        since_when: u64,
        latency: f64,
        flags: u32,
    ) -> *mut c_void;
    fn FSEventStreamSetDispatchQueue(stream: *mut c_void, queue: *mut c_void);
    fn FSEventStreamStart(stream: *mut c_void) -> u8;
    fn FSEventStreamStop(stream: *mut c_void);
    fn FSEventStreamFlushSync(stream: *mut c_void);
    fn FSEventStreamInvalidate(stream: *mut c_void);
    fn FSEventStreamRelease(stream: *mut c_void);
}

#[link(name = "DiskArbitration", kind = "framework")]
unsafe extern "C" {
    static kDADiskDescriptionDeviceInternalKey: CFStringRef;
    static kDADiskDescriptionVolumeUUIDKey: CFStringRef;
    fn DASessionCreate(allocator: CFAllocatorRef) -> *const c_void;
    fn DADiskCreateFromBSDName(
        allocator: CFAllocatorRef,
        session: *const c_void,
        name: *const c_char,
    ) -> *const c_void;
    fn DADiskCopyDescription(disk: *const c_void) -> CFDictionaryRef;
}

unsafe extern "C" {
    fn dispatch_queue_create(label: *const c_char, attributes: *const c_void) -> *mut c_void;
    fn dispatch_sync_f(
        queue: *mut c_void,
        context: *mut c_void,
        function: unsafe extern "C" fn(*mut c_void),
    );
    fn dispatch_release(queue: *mut c_void);
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::MetadataExt,
        thread,
        time::{Duration, Instant},
    };

    use super::{Volume, Watcher, current_event_id};

    #[test]
    fn native_stream_receives_an_actual_apfs_rename_and_delete() {
        let directory = tempfile::tempdir().expect("temporary working directory");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical working directory");
        let device = fs::metadata(&root).expect("root metadata").dev();
        let volume = Volume::for_path(&root, device).expect("test directory is on internal APFS");
        let old = root.join("起草.md");
        let new = root.join("定稿.md");
        fs::write(&old, "test").expect("create initial file");
        let watcher = Watcher::start(&volume, &root, None).expect("start native stream");
        assert!(watcher.history_complete());
        fs::rename(&old, &new).expect("rename file");
        let deadline = Instant::now() + Duration::from_secs(7);
        let mut events = Vec::new();
        while Instant::now() < deadline {
            watcher.flush();
            watcher.take(current_event_id(), &mut events);
            if events
                .iter()
                .any(|event| event.path == new && event.observed_rename_ms.is_some())
            {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert!(
            events
                .iter()
                .any(|event| event.path == new && event.observed_rename_ms.is_some()),
            "real rename did not arrive"
        );
        let rename_id = events
            .iter()
            .map(|event| event.id)
            .max()
            .expect("rename event ID");
        fs::remove_file(&new).expect("delete file");
        let deadline = Instant::now() + Duration::from_secs(7);
        while Instant::now() < deadline {
            watcher.flush();
            watcher.take(current_event_id(), &mut events);
            if events
                .iter()
                .any(|event| event.path == new && event.id > rename_id)
            {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        panic!("real removal did not arrive");
    }
}
