use crate::audio::Language;

pub trait SpeechProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn supports(&self, source: &Language, target: &Language) -> bool;
}

pub struct SarvamProvider;
impl SpeechProvider for SarvamProvider {
    fn name(&self) -> &'static str { "sarvam" }
    fn supports(&self, source: &Language, target: &Language) -> bool {
        matches!(source, Language::Auto | Language::Hi | Language::Ta | Language::Te | Language::Bn | Language::Mr | Language::En)
            && matches!(target, Language::En | Language::Hi | Language::Ta | Language::Te | Language::Bn | Language::Mr)
    }
}

pub struct InternationalSpeechProvider;
impl SpeechProvider for InternationalSpeechProvider {
    fn name(&self) -> &'static str { "international-stt" }
    fn supports(&self, _source: &Language, _target: &Language) -> bool { true }
}

pub struct ProviderRouter { providers: Vec<Box<dyn SpeechProvider>> }
impl Default for ProviderRouter { fn default() -> Self { Self { providers: vec![Box::new(SarvamProvider), Box::new(InternationalSpeechProvider)] } } }
impl ProviderRouter {
    pub fn select(&self, source: &Language, target: &Language) -> &dyn SpeechProvider {
        self.providers.iter().find(|provider| provider.supports(source, target)).map(|provider| provider.as_ref()).unwrap_or_else(|| self.providers.last().expect("router has a fallback provider").as_ref())
    }
}
