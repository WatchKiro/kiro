//! Android-only setup.

use jni::JavaVM;
use jni::objects::JObject;

/// reqwest verifies certificates with `rustls-platform-verifier`, which on
/// Android asks the system's trust manager through the JVM (its Kotlin half
/// is `org.rustls:rustls-platform-verifier` in the Gradle build). It must be
/// given the JVM and the application context before the first request.
///
/// Tao publishes both to `ndk-context` when the activity is created, before
/// Tauri's setup runs.
pub fn init_tls_verifier() -> Result<(), jni::errors::Error> {
    let android = ndk_context::android_context();
    // SAFETY: `ndk-context` holds the process's JavaVM and a global
    // reference to the application context for the life of the process.
    let vm = unsafe { JavaVM::from_raw(android.vm().cast()) };
    vm.attach_current_thread(|env| {
        let context = unsafe { JObject::from_raw(env, android.context().cast()) };
        rustls_platform_verifier::android::init_with_env(env, context)
    })
}
