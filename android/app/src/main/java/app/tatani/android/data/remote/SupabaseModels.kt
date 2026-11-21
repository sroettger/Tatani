package app.tatani.android.data.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class AuthUserDto(
    val id: String,
    val email: String? = null,
)

@Serializable
data class AuthTokenResponseDto(
    @SerialName("access_token") val accessToken: String? = null,
    @SerialName("refresh_token") val refreshToken: String? = null,
    @SerialName("expires_in") val expiresIn: Long = 3600L,
    val user: AuthUserDto? = null,
    @SerialName("error_description") val errorDescription: String? = null,
    val msg: String? = null,
)

@Serializable
data class ProfileDto(
    @SerialName("user_id") val userId: String,
    @SerialName("learning_language") val learningLanguage: String = "ja",
    @SerialName("ui_language") val uiLanguage: String = "en",
)

@Serializable
data class LanguageProgressDto(
    @SerialName("learning_language") val learningLanguage: String = "ja",
    val level: String = "none",
    @SerialName("placement_done") val placementDone: Boolean = true,
)

@Serializable
data class UserWordStateDto(
    @SerialName("user_id") val userId: String? = null,
    val word: String,
    val reading: String? = null,
    val level: String? = null,
    @SerialName("learning_language") val learningLanguage: String = "ja",
    val state: String = "unknown",
    val preference: String = "study",
    @SerialName("known_source") val knownSource: String? = null,
    @SerialName("correct_streak") val correctStreak: Int = 0,
    @SerialName("srs_level") val srsLevel: Int = 0,
    @SerialName("srs_due_at") val srsDueAt: String? = null,
    @SerialName("last_reviewed_at") val lastReviewedAt: String? = null,
    @SerialName("marked_known_at") val markedKnownAt: String? = null,
)

@Serializable
data class AnimeCatalogDto(
    val id: String,
    @SerialName("title_romaji") val titleRomaji: String,
    @SerialName("title_en") val titleEn: String? = null,
    @SerialName("title_jp") val titleJp: String? = null,
    @SerialName("cover_url") val coverUrl: String? = null,
)

@Serializable
data class UserAnimeRowDto(
    val position: Int = 0,
    val anime: AnimeCatalogDto? = null,
)

@Serializable
data class SeasonNestedDto(
    @SerialName("anime_id") val animeId: String,
    @SerialName("season_number") val seasonNumber: Int = 1,
)

@Serializable
data class EpisodeRowDto(
    val id: String,
    @SerialName("episode_number") val episodeNumber: Int,
    @SerialName("processing_status") val processingStatus: String = "pending",
    val seasons: SeasonNestedDto,
)

@Serializable
data class RawVocabItemDto(
    val word: String = "",
    val reading: String? = null,
    val meaning: String? = null,
    @SerialName("part_of_speech") val partOfSpeech: String? = null,
    @SerialName("jlpt_level") val jlptLevel: String? = null,
    val level: String? = null,
    @SerialName("example_sentence_jp") val exampleSentenceJp: String? = null,
    @SerialName("example_sentence_en") val exampleSentenceEn: String? = null,
    val frequency: Int? = null,
)

@Serializable
data class EpisodeVocabCacheDto(
    @SerialName("episode_id") val episodeId: String,
    val vocab: List<RawVocabItemDto> = emptyList(),
)

@Serializable
data class StudyChunkIdDto(
    val id: String,
)

@Serializable
data class StudyChunkWordDto(
    val word: String,
    val reading: String? = null,
    val meaning: String? = null,
    @SerialName("part_of_speech") val partOfSpeech: String? = null,
    val level: String? = null,
    @SerialName("example_sentence_jp") val exampleSentenceJp: String? = null,
    @SerialName("example_sentence_en") val exampleSentenceEn: String? = null,
)

@Serializable
data class AnimeSearchResultDto(
    @SerialName("anilist_id") val anilistId: Int,
    @SerialName("mal_id") val malId: Int? = null,
    @SerialName("title_romaji") val titleRomaji: String,
    @SerialName("title_en") val titleEn: String? = null,
    @SerialName("title_jp") val titleJp: String? = null,
    @SerialName("cover_url") val coverUrl: String? = null,
    val year: Int? = null,
    @SerialName("episode_count") val episodeCount: Int = 0,
    val synopsis: String? = null,
)

@Serializable
data class SearchAnimeResponseDto(
    val results: List<AnimeSearchResultDto> = emptyList(),
    val error: String? = null,
)

@Serializable
data class FetchSubtitlesResponseDto(
    val found: Boolean = false,
    val content: String? = null,
    val error: String? = null,
)
