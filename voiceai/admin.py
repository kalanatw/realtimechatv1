from django.contrib import admin
from .models import Conversation

@admin.register(Conversation)
class ConversationAdmin(admin.ModelAdmin):
    list_display = ('id', 'user_message', 'created_at')
    search_fields = ('user_message', 'ai_response')
    readonly_fields = ('created_at',)
    list_filter = ('created_at',)
    date_hierarchy = 'created_at'
